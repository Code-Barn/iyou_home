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

import type { CSSProperties } from "react";

interface MessageBubbleProps {
  body: string;
  direction: "out" | "in";
  encrypted: boolean;
  timestamp: number;
  sender: string;
}

export default function MessageBubble({
  body,
  direction,
  encrypted,
  timestamp,
  sender,
}: MessageBubbleProps) {
  const isOut = direction === "out";
  const bubbleStyle: CSSProperties = {
    maxWidth: "72%",
    padding: "0.55rem 0.8rem",
    borderRadius: "12px",
    fontSize: "0.86rem",
    lineHeight: "1.45",
    wordBreak: "break-word",
    background: isOut ? "#2563eb" : "#f3f4f6",
    color: isOut ? "white" : "#1f2937",
    alignSelf: isOut ? "flex-end" : "flex-start",
    border: isOut ? "none" : "1px solid #e5e7eb",
  };

  const label = `${isOut ? "You" : sender}: ${new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  })}`;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: isOut ? "flex-end" : "flex-start",
      }}
    >
      <div style={bubbleStyle}>
        {encrypted && (
          <span
            style={{
              marginRight: "0.3rem",
              fontSize: "0.72rem",
              opacity: 0.85,
            }}
            title="Sealed with the OMEMO envelope"
          >
            🔒
          </span>
        )}
        {body}
      </div>
      <div
        style={{
          fontSize: "0.68rem",
          color: "#9ca3af",
          marginTop: "2px",
          marginLeft: isOut ? 0 : "0.4rem",
          marginRight: isOut ? "0.4rem" : 0,
        }}
      >
        {label}
      </div>
    </div>
  );
}