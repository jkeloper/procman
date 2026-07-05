import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
} from "procman"
import { SearchIcon, XIcon } from "lucide-react"

export function SearchField() {
  return (
    <div style={{ maxWidth: 340 }}>
      <InputGroup>
        <InputGroupAddon align="inline-start">
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput placeholder="Filter processes…" defaultValue="dashboard" />
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label="Clear">
            <XIcon />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}

export function PortField() {
  return (
    <div style={{ maxWidth: 340 }}>
      <InputGroup>
        <InputGroupAddon align="inline-start">
          <InputGroupText>PORT</InputGroupText>
        </InputGroupAddon>
        <InputGroupInput defaultValue="5173" />
        <InputGroupAddon align="inline-end">
          <InputGroupButton>Check</InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </div>
  )
}
