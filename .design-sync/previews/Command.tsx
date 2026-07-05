import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
  CommandShortcut,
} from "procman"

export function Palette() {
  return (
    <div style={{ width: 460, border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden" }}>
      <Command shouldFilter={false}>
        <CommandInput placeholder="Type a command or search…" />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Processes">
            <CommandItem>Start all<CommandShortcut>⌘⏎</CommandShortcut></CommandItem>
            <CommandItem>Restart web-dashboard</CommandItem>
            <CommandItem>Stop api-server</CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="View">
            <CommandItem>Open logs<CommandShortcut>⌘L</CommandShortcut></CommandItem>
            <CommandItem>Dashboard<CommandShortcut>⌘,</CommandShortcut></CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  )
}
