// Per-process log ring buffer (T15).
//
// LEARN (bounded collections in Rust):
//   - `VecDeque<T>` is a ring buffer with O(1) push/pop at both ends.
//   - We keep a monotonic `seq` counter to let the frontend gap-detect and
//     resume after temporary disconnects.
//   - When `buf.len() == capacity`, pushing drops the oldest entry. The
//     seq counter still advances so clients can tell.

use serde::Serialize;
use std::collections::VecDeque;

use crate::types::LogStream;

#[derive(Debug, Clone, Serialize)]
pub struct LogLine {
    pub seq: u64,
    pub ts_ms: i64,
    pub stream: LogStream,
    pub text: String,
}

pub struct LogBuffer {
    buf: VecDeque<LogLine>,
    capacity: usize,
    next_seq: u64,
}

impl LogBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            buf: VecDeque::with_capacity(capacity),
            capacity,
            next_seq: 1,
        }
    }

    pub fn push(&mut self, stream: LogStream, text: String) -> LogLine {
        let line = LogLine {
            seq: self.next_seq,
            ts_ms: chrono_like_now_ms(),
            stream,
            text,
        };
        self.next_seq += 1;
        if self.buf.len() == self.capacity {
            self.buf.pop_front();
        }
        self.buf.push_back(line.clone());
        line
    }

    pub fn snapshot(&self) -> Vec<LogLine> {
        self.buf.iter().cloned().collect()
    }

    pub fn tail(&self, n: usize) -> Vec<LogLine> {
        let take = n.min(self.buf.len());
        self.buf
            .iter()
            .skip(self.buf.len() - take)
            .cloned()
            .collect()
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn clear(&mut self) {
        self.buf.clear();
    }
}

fn chrono_like_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_assigns_monotonic_seq() {
        let mut b = LogBuffer::new(10);
        let l1 = b.push(LogStream::Stdout, "a".into());
        let l2 = b.push(LogStream::Stdout, "b".into());
        assert_eq!(l1.seq, 1);
        assert_eq!(l2.seq, 2);
        assert_eq!(b.len(), 2);
    }

    #[test]
    fn evicts_oldest_at_capacity() {
        let mut b = LogBuffer::new(3);
        for i in 0..5 {
            b.push(LogStream::Stdout, format!("line-{}", i));
        }
        assert_eq!(b.len(), 3);
        let snap = b.snapshot();
        // Expect last 3 lines (seq 3, 4, 5)
        assert_eq!(snap[0].seq, 3);
        assert_eq!(snap[0].text, "line-2");
        assert_eq!(snap[2].seq, 5);
        assert_eq!(snap[2].text, "line-4");
    }

    #[test]
    fn tail_returns_last_n() {
        let mut b = LogBuffer::new(100);
        for i in 0..10 {
            b.push(LogStream::Stdout, format!("l{}", i));
        }
        let t = b.tail(3);
        assert_eq!(t.len(), 3);
        assert_eq!(t[0].text, "l7");
        assert_eq!(t[2].text, "l9");
    }
}
