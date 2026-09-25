import { cn } from "@/lib/utils";

/**
 * Wraps LTR content (phone numbers, emails, links, English text) so the
 * bidi algorithm doesn't garble it inside an RTL page.
 */
export function Ltr({
  children,
  className,
  as: Component = "span",
}: {
  children: React.ReactNode;
  className?: string;
  as?: "span" | "div";
}) {
  return (
    <Component
      dir="ltr"
      className={cn("inline-block text-left [unicode-bidi:isolate] tabular-nums", className)}
    >
      {children}
    </Component>
  );
}
