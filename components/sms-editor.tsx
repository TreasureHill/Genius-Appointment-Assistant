"use client";

import { useRef } from "react";
import { MERGE_TAGS } from "@/lib/merge";
import { smsSegments } from "@/lib/sms-segments";

type Props = {
  body: string;
  onChange: (v: string) => void;
};

export function SmsEditor({ body, onChange }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const segments = smsSegments(body);

  function insertTag(tag: string) {
    const el = ref.current;
    if (!el) { onChange(body + tag); return; }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const next = body.slice(0, start) + tag + body.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + tag.length, start + tag.length);
    });
  }

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
          {MERGE_TAGS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <div className="ml-auto text-xs text-slate-500">
          {body.length} chars · {segments} segment{segments === 1 ? "" : "s"}
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
