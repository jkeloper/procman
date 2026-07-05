import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "procman"

export function ConfirmStop() {
  return (
    <Dialog defaultOpen>
      <DialogContent showCloseButton>
        <DialogHeader>
          <DialogTitle>Stop web-dashboard?</DialogTitle>
          <DialogDescription>
            The dev server will be terminated with SIGTERM, then SIGKILL after 5s.
            Buffered log output is kept and the port is released.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button variant="destructive">Stop process</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
