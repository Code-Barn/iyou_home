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

import { useEffect, useRef } from "react";
import type { ChatTranscriptEntry } from "../../../lib/omemoSession";
import MessageBubble from "./MessageBubble";

interface MessageThreadProps {
  messages: ChatTranscriptEntry[];
  emptyText: string;
}

export default function MessageThread({ messages, emptyText }: MessageThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
  }, [messages.length]);

  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        padding: "1rem",
        background: "#f9fafb",
      }}
    >
      {messages.length === 0 ? (
        <div
          style={{
            margin: "auto",
            textAlign: "center",
            color: "#9ca3af",
            fontSize: "0.85rem",
            maxWidth: "24rem",
            lineHeight: 1.6,
          }}
        >
          {emptyText}
        </div>
      ) : (
        messages.map((message) => (
          <MessageBubble
            key={message.id}
            body={message.body}
            direction={message.direction}
            encrypted={message.encrypted}
            timestamp={message.timestamp}
            sender={message.sender}
          />
        ))
      )}
      <div ref={bottomRef} />
    </div>
  );
}