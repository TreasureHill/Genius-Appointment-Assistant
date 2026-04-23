import { useRef } from "react";
import { MERGE_TAGS } from "./EmailEditor";

function segments(body: string): number {
  const isUnicode = /[^\x00-\x7F]/.test(body);
  if (isUnicode) return body.length <= 70 ? 1 : Math.ceil(body.length / 67);
  return body.length <= 160 ? 1 : Math.ceil(body.length / 153);
}

type Props = {
  body: string;
  onChange: (v: string) => void;
};

export function SmsEditor({ body, onChange }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  function insertTag(tag: string) {
    const el = ref.current;
    if (!el) {
      onChange(body + tag);
      return;
    }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const next = body.slice(0, start) + tag + body.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + tag.length, start + tag.length);
    });
  }

  const seg = segments(body);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <select
          className="rounded border border-slate-200 px-2 py-1 text-sm"
          defaultValue=""
          onChange={(e) => {
            if (e.target.value) insertTag(e.target.value);
            e.target.value = "";
          }}
        >
          <option value="">Insert merge tag…</option>
          {MERGE_TAGS.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <div className="ml-auto text-xs text-slate-500">
          {body.length} chars · {seg} segment{seg === 1 ? "" : "s"}
        </div>
      </div>
      <textarea
        ref={ref}
        className="input min-h-[140px]"
        value={body}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
