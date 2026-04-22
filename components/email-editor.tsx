"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { useEffect, useState } from "react";
import { MERGE_TAGS } from "@/lib/merge";

type Props = {
  html: string;
  onChange: (html: string) => void;
};

export function EmailEditor({ html, onChange }: Props) {
  const [mode, setMode] = useState<"wysiwyg" | "html">("wysiwyg");
  const [raw, setRaw] = useState(html);

  const editor = useEditor({
    extensions: [StarterKit, Link.configure({ openOnClick: false })],
    content: html,
    immediatelyRender: false,
    onUpdate: ({ editor }) => {
      const v = editor.getHTML();
      setRaw(v);
      onChange(v);
    },
  });

  useEffect(() => {
    if (mode === "wysiwyg" && editor) {
      if (editor.getHTML() !== raw) editor.commands.setContent(raw);
    }
  }, [mode, editor, raw]);

  function insertTag(tag: string) {
    if (mode === "wysiwyg" && editor) {
      editor.chain().focus().insertContent(tag).run();
    } else {
      const next = raw + tag;
      setRaw(next);
      onChange(next);
    }
  }

  function toggleLink() {
    if (!editor) return;
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", prev ?? "https://");
    if (url === null) return;
    if (url === "") {
      editor.chain().focus().unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }

  if (!editor) return null;

  const btn = (label: string, active: boolean, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-1 text-sm ${active ? "bg-brand-100 text-brand-700" : "text-slate-700 hover:bg-slate-100"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1 rounded-md border border-slate-200 bg-white p-1">
        {btn("B", editor.isActive("bold"), () => editor.chain().focus().toggleBold().run())}
        {btn("I", editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run())}
        {btn("H1", editor.isActive("heading", { level: 1 }), () => editor.chain().focus().toggleHeading({ level: 1 }).run())}
        {btn("H2", editor.isActive("heading", { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run())}
        {btn("• List", editor.isActive("bulletList"), () => editor.chain().focus().toggleBulletList().run())}
        {btn("1. List", editor.isActive("orderedList"), () => editor.chain().focus().toggleOrderedList().run())}
        {btn("Link", editor.isActive("link"), toggleLink)}
        <div className="mx-2 h-5 w-px bg-slate-200" />
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
        <div className="ml-auto flex items-center gap-1">
          {btn("WYSIWYG", mode === "wysiwyg", () => setMode("wysiwyg"))}
          {btn("Source", mode === "html", () => setMode("html"))}
        </div>
      </div>

      {mode === "wysiwyg" ? (
        <EditorContent editor={editor} className="tiptap" />
      ) : (
        <textarea
          className="input font-mono min-h-[240px]"
          value={raw}
          onChange={(e) => { setRaw(e.target.value); onChange(e.target.value); }}
        />
      )}
    </div>
  );
}
