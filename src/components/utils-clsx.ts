export default function clsx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}
