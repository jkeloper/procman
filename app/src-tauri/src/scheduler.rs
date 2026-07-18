use crate::process::ProcessManager;
use crate::state::AppState;
use crate::types::Script;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

static SCHEDULER_STARTED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
const SCHEDULER_TICK_SECS: u64 = 15;

#[derive(Debug, Clone)]
struct ScheduledScript {
    project_path: String,
    script: Script,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TimeParts {
    minute: u32,
    hour: u32,
    day_of_month: u32,
    month: u32,
    day_of_week: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CronField {
    unrestricted: bool,
    values: BTreeSet<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CronSchedule {
    minute: CronField,
    hour: CronField,
    day_of_month: CronField,
    month: CronField,
    day_of_week: CronField,
}

/// Validate a user-provided five-field cron expression.
pub(crate) fn validate_cron_expr(expr: &str) -> Result<(), String> {
    CronSchedule::parse(expr).map(|_| ())
}

/// Start the background scheduled-execution loop. Idempotent per app run.
pub fn start_scheduler(state: Arc<AppState>, pm: ProcessManager) {
    if SCHEDULER_STARTED.set(()).is_err() {
        log::debug!("scheduler already running; skipping duplicate");
        return;
    }

    tauri::async_runtime::spawn(async move {
        // Align the first pass to the next minute boundary so `* * * * *`
        // behaves like cron instead of firing immediately on app startup.
        let now = unix_secs();
        let wait = 60_u64.saturating_sub((now.rem_euclid(60)) as u64);
        tokio::time::sleep(Duration::from_secs(wait.max(1))).await;

        let mut last_minute: Option<i64> = None;
        loop {
            if let Err(e) = run_scheduler_minute(&state, &pm, &mut last_minute).await {
                log::warn!("scheduled execution tick failed: {e}");
            }
            tokio::time::sleep(Duration::from_secs(SCHEDULER_TICK_SECS)).await;
        }
    });
}

async fn run_scheduler_minute(
    state: &Arc<AppState>,
    pm: &ProcessManager,
    last_minute: &mut Option<i64>,
) -> Result<(), String> {
    let now = unix_secs();
    let minute_key = now.div_euclid(60);
    if *last_minute == Some(minute_key) {
        return Ok(());
    }
    *last_minute = Some(minute_key);

    let time = local_time_parts(now).ok_or_else(|| "could not resolve local time".to_string())?;
    let candidates = scheduled_scripts(state).await;

    for scheduled in candidates {
        let Some(spec) = scheduled.script.schedule.as_ref() else {
            continue;
        };
        let schedule = match CronSchedule::parse(&spec.cron) {
            Ok(schedule) => schedule,
            Err(e) => {
                log::warn!(
                    "skipping invalid schedule for script '{}': {}",
                    scheduled.script.name,
                    e
                );
                continue;
            }
        };
        if !schedule.matches(time) {
            continue;
        }
        if pm.is_live(&scheduled.script.id) {
            log::debug!(
                "scheduled script '{}' is already running; skipping",
                scheduled.script.name
            );
            continue;
        }
        // Move the (potentially 30s) dependency wait + conflict check + spawn
        // into its own task so one candidate waiting on an unready dependency
        // can't stall sibling candidates or push out the next tick. Distinct
        // scripts are distinct DashMap keys; pm.spawn's in-flight guard plus
        // the is_live recheck below keep a same-id double-launch safe.
        let state = Arc::clone(state);
        let pm = pm.clone();
        tauri::async_runtime::spawn(async move {
            let script = &scheduled.script;
            if !script.depends_on.is_empty() {
                if let Err(e) =
                    crate::commands::process::wait_for_dependencies(&state, &pm, &script.depends_on)
                        .await
                {
                    log::warn!(
                        "scheduled script '{}' skipped while waiting for dependencies: {}",
                        script.name,
                        e
                    );
                    return;
                }
            }
            match crate::commands::port::blocking_conflicts_for_script(
                &script.id,
                &script.ports,
                &state,
                &pm,
            )
            .await
            {
                Ok(conflicts) => {
                    if let Some(conflict) = conflicts.first() {
                        log::warn!(
                            "scheduled script '{}' skipped: {}",
                            script.name,
                            crate::commands::port::describe_port_conflict(conflict)
                        );
                        return;
                    }
                }
                Err(e) => {
                    log::warn!(
                        "scheduled script '{}' conflict check failed: {}",
                        script.name,
                        e
                    );
                    return;
                }
            }
            // Final guard immediately before spawn — no await in between.
            if pm.is_live(&script.id) {
                return;
            }
            match pm.spawn(script, Some(scheduled.project_path.clone())).await {
                Ok(pid) => log::info!(
                    "scheduled script '{}' started with pid {}",
                    script.name,
                    pid
                ),
                Err(e) => log::warn!("scheduled script '{}' failed to start: {}", script.name, e),
            }
        });
    }
    Ok(())
}

async fn scheduled_scripts(state: &AppState) -> Vec<ScheduledScript> {
    let guard = state.config.lock().await;
    let mut out = Vec::new();
    for project in &guard.projects {
        for script in &project.scripts {
            if script
                .schedule
                .as_ref()
                .map(|spec| spec.enabled)
                .unwrap_or(false)
            {
                out.push(ScheduledScript {
                    project_path: project.path.clone(),
                    script: script.clone(),
                });
            }
        }
    }
    out
}

impl CronSchedule {
    fn parse(expr: &str) -> Result<Self, String> {
        let fields: Vec<&str> = expr.split_whitespace().collect();
        if fields.len() != 5 {
            return Err("cron must have 5 fields: minute hour day month weekday".to_string());
        }
        Ok(Self {
            minute: CronField::parse(fields[0], 0, 59, "minute")?,
            hour: CronField::parse(fields[1], 0, 23, "hour")?,
            day_of_month: CronField::parse(fields[2], 1, 31, "day-of-month")?,
            month: CronField::parse(fields[3], 1, 12, "month")?,
            day_of_week: CronField::parse(fields[4], 0, 7, "day-of-week")?,
        })
    }

    fn matches(&self, time: TimeParts) -> bool {
        if !self.minute.matches(time.minute)
            || !self.hour.matches(time.hour)
            || !self.month.matches(time.month)
        {
            return false;
        }

        let dom_match = self.day_of_month.matches(time.day_of_month);
        let dow_match = self.day_of_week.matches(time.day_of_week)
            || (time.day_of_week == 0 && self.day_of_week.matches(7));
        match (
            self.day_of_month.unrestricted,
            self.day_of_week.unrestricted,
        ) {
            (true, true) => true,
            (true, false) => dow_match,
            (false, true) => dom_match,
            (false, false) => dom_match || dow_match,
        }
    }
}

impl CronField {
    fn parse(input: &str, min: u32, max: u32, label: &str) -> Result<Self, String> {
        let input = input.trim();
        if input.is_empty() {
            return Err(format!("{label} field cannot be empty"));
        }

        let unrestricted = input == "*" || input == "*/1";
        let mut values = BTreeSet::new();
        for part in input.split(',') {
            let part = part.trim();
            if part.is_empty() {
                return Err(format!("{label} field contains an empty list item"));
            }
            let (base, step) = match part.split_once('/') {
                Some((base, step)) => {
                    let parsed_step = step
                        .parse::<u32>()
                        .map_err(|_| format!("{label} step must be a positive number"))?;
                    if parsed_step == 0 {
                        return Err(format!("{label} step must be greater than 0"));
                    }
                    (base, parsed_step)
                }
                None => (part, 1),
            };

            let (start, end) = if base == "*" {
                (min, max)
            } else if let Some((start, end)) = base.split_once('-') {
                (
                    parse_number(start, min, max, label)?,
                    parse_number(end, min, max, label)?,
                )
            } else {
                let value = parse_number(base, min, max, label)?;
                (value, value)
            };

            if start > end {
                return Err(format!("{label} range must be ascending"));
            }
            let mut value = start;
            while value <= end {
                values.insert(value);
                match value.checked_add(step) {
                    Some(next) => value = next,
                    None => break,
                }
            }
        }

        if values.is_empty() {
            return Err(format!("{label} field did not select any values"));
        }
        Ok(Self {
            unrestricted,
            values,
        })
    }

    fn matches(&self, value: u32) -> bool {
        self.values.contains(&value)
    }
}

fn parse_number(input: &str, min: u32, max: u32, label: &str) -> Result<u32, String> {
    let value = input
        .parse::<u32>()
        .map_err(|_| format!("{label} value '{input}' is not a number"))?;
    if value < min || value > max {
        return Err(format!("{label} value {value} is outside {min}..={max}"));
    }
    Ok(value)
}

fn unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(unix)]
fn local_time_parts(timestamp: i64) -> Option<TimeParts> {
    let raw = timestamp as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let ptr = unsafe { libc::localtime_r(&raw, &mut tm) };
    if ptr.is_null() {
        return None;
    }
    Some(TimeParts {
        minute: tm.tm_min as u32,
        hour: tm.tm_hour as u32,
        day_of_month: tm.tm_mday as u32,
        month: (tm.tm_mon + 1) as u32,
        day_of_week: tm.tm_wday as u32,
    })
}

#[cfg(not(unix))]
fn local_time_parts(_timestamp: i64) -> Option<TimeParts> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(minute: u32, hour: u32, day_of_month: u32, month: u32, day_of_week: u32) -> TimeParts {
        TimeParts {
            minute,
            hour,
            day_of_month,
            month,
            day_of_week,
        }
    }

    #[test]
    fn validates_common_cron_shapes() {
        validate_cron_expr("* * * * *").unwrap();
        validate_cron_expr("*/15 9-17 * * 1-5").unwrap();
        validate_cron_expr("0,30 8,18 1 1,6,12 0").unwrap();
    }

    #[test]
    fn rejects_invalid_cron_shapes() {
        assert!(validate_cron_expr("* * * *").is_err());
        assert!(validate_cron_expr("60 * * * *").is_err());
        assert!(validate_cron_expr("* */0 * * *").is_err());
        assert!(validate_cron_expr("* * 20-10 * *").is_err());
    }

    #[test]
    fn matches_steps_ranges_and_lists() {
        let schedule = CronSchedule::parse("*/15 9-17 * * 1-5").unwrap();
        assert!(schedule.matches(at(30, 10, 12, 5, 3)));
        assert!(!schedule.matches(at(31, 10, 12, 5, 3)));
        assert!(!schedule.matches(at(30, 18, 12, 5, 3)));
        assert!(!schedule.matches(at(30, 10, 12, 5, 6)));
    }

    #[test]
    fn treats_zero_and_seven_as_sunday() {
        let schedule = CronSchedule::parse("0 9 * * 7").unwrap();
        assert!(schedule.matches(at(0, 9, 12, 5, 0)));
    }

    #[test]
    fn uses_cron_day_or_semantics_when_both_day_fields_are_restricted() {
        let schedule = CronSchedule::parse("0 9 1 * 5").unwrap();
        assert!(schedule.matches(at(0, 9, 1, 5, 2)));
        assert!(schedule.matches(at(0, 9, 12, 5, 5)));
        assert!(!schedule.matches(at(0, 9, 12, 5, 2)));
    }
}
