/*
 * Copyright (C) 2026 David Byers dba Byers Brands
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import { useState } from "react";
import type { KeyboardEvent } from "react";

interface ChatComposerProps {
  onSend: (text: string) => void;
  disabled: boolean;
  placeholder: string;
}

export default function ChatComposer({ onSend, disabled, placeholder }: ChatComposerProps) {
  const [draft, setDraft] = useState("");

  const submit = () => {
    const text = draft.trim();
    if (!text || disabled) {
      return;
    }
    onSend(text);
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div
      style={{
        display: "flex",
        gap: "0.5rem",
        padding: "0.75rem 1rem",
        borderTop: "1px solid #e5e7eb",
        background: "white",
      }}
    >
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={2}
        disabled={disabled}
        style={{
          flex: 1,
          resize: "none",
          padding: "0.5rem 0.75rem",
          borderRadius: "8px",
          border: "1px solid #d1d5db",
          fontSize: "0.86rem",
          fontFamily: "inherit",
        }}
      />
      <button
        type="button"
        onClick={submit}
        disabled={disabled || draft.trim().length === 0}
        style={{
          padding: "0.5rem 1.1rem",
          background: disabled ? "#9ca3af" : "#2563eb",
          color: "white",
          border: "none",
          borderRadius: "8px",
          fontWeight: 600,
          fontSize: "0.85rem",
          cursor: disabled ? "not-allowed" : "pointer",
        }}
      >
        Send
      </button>
    </div>
  );
}