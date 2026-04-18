"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/40 supports-backdrop-filter:backdrop-blur-sm data-open:animate-in data-open:fade-in-0 data-open:duration-200 data-closed:animate-out data-closed:fade-out-0 data-closed:duration-150",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
}) {
  // Split children into header / footer / body by matching on
  // React element data-slot. DialogHeader and DialogFooter keep their
  // natural height (shrink-0). Everything else goes into a flex-1
  // scroll region in the middle. This lets the dialog cap at viewport
  // height while scrolling only the body, keeping title and action
  // buttons always visible without the sticky-positioning glitches.
  const childArray = React.Children.toArray(children);
  const header: React.ReactNode[] = [];
  const footer: React.ReactNode[] = [];
  const body: React.ReactNode[] = [];
  for (const child of childArray) {
    if (React.isValidElement(child)) {
      const slot = (child.props as { ["data-slot"]?: string })?.["data-slot"];
      if (slot === "dialog-header") {
        header.push(child);
        continue;
      }
      if (slot === "dialog-footer") {
        footer.push(child);
        continue;
      }
    }
    body.push(child);
  }

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          // Base geometry — fixed+centered, width capped to viewport
          "fixed top-1/2 left-1/2 z-50 w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 sm:max-w-2xl",
          // Height cap to viewport, flex column so the middle body
          // region can scroll independently without moving header/footer.
          "flex max-h-[calc(100vh-4rem)] flex-col overflow-hidden",
          // Visual treatment
          "rounded-xl bg-popover text-sm text-popover-foreground ring-1 ring-foreground/10 outline-none",
          // Animations
          "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.85] data-open:duration-250 data-open:ease-out data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-closed:duration-150 data-closed:ease-in",
          className
        )}
        {...props}
      >
        {header}
        {body.length > 0 && (
          <div
            data-slot="dialog-body"
            className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-4"
          >
            {body}
          </div>
        )}
        {footer}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-2 right-2 z-20"
                size="icon-sm"
              />
            }
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        // Pinned at the top of the dialog via flex-column ordering.
        // DialogContent puts header first and it never shrinks.
        "flex shrink-0 flex-col gap-2 border-b border-border/40 px-6 pt-6 pb-4",
        className
      )}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        // Pinned at the bottom of the dialog via flex-column ordering.
        // DialogContent puts footer last and it never shrinks.
        "flex shrink-0 flex-col-reverse gap-2 rounded-b-xl border-t border-border/40 p-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-base leading-none font-medium",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
