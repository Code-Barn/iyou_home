/*
 * Copyright (C) 2026 Byers Brands, LLC
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

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import App from "../App";
import { invoke } from "@tauri-apps/api/core";

// Mock the invoke function from Tauri
vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(),
    Channel: vi.fn().mockImplementation(() => ({
        onmessage: null,
    })),
}));

describe("App", () => {
    it("renders the service switch panel", () => {
        render(<App />);
        expect(screen.getByText("Service Switch Panel")).toBeInTheDocument();
        expect(screen.getByText("SigBridge")).toBeInTheDocument();
        expect(screen.getByText("Nostr")).toBeInTheDocument();
        expect(screen.getByText("Blossom")).toBeInTheDocument();
        expect(screen.getByText("Chat")).toBeInTheDocument();
        expect(screen.getByText("IPFS")).toBeInTheDocument();
        expect(screen.getByText("Polly")).toBeInTheDocument();
    });

    it("shows ports for active services", () => {
        render(<App />);
        expect(screen.getByText(":9001")).toBeInTheDocument();
        expect(screen.getByText(":9002")).toBeInTheDocument();
        expect(screen.getByText(":9003")).toBeInTheDocument();
        expect(screen.getByText(":5222")).toBeInTheDocument();
    });

    it("calls the toggle_service command when a start button is clicked", async () => {
        (invoke as any).mockResolvedValue("running");
        render(<App />);

        const startButtons = screen.getAllByRole("button", {
            name: /start/i,
        });
        expect(startButtons.length).toBe(3);

        fireEvent.click(startButtons[0]);

        await waitFor(() => {
            expect(invoke).toHaveBeenCalledWith("toggle_service", {
                name: "Blossom",
                action: "start",
            });
        });

        expect(await screen.findByText("Stop")).toBeInTheDocument();
    });

    it("handles service stop correctly", async () => {
        (invoke as any).mockResolvedValueOnce("running");
        (invoke as any).mockResolvedValueOnce("running");
        (invoke as any).mockResolvedValueOnce("stopped");

        render(<App />);

        const startButtons = screen.getAllByRole("button", {
            name: /start/i,
        });
        fireEvent.click(startButtons[0]);

        const stopButton = await screen.findByText("Stop");
        fireEvent.click(stopButton);

        await waitFor(() => {
            expect(invoke).toHaveBeenCalledWith("toggle_service", {
                name: "Blossom",
                action: "stop",
            });
        });

        const startButtonsAfter = await screen.findAllByRole("button", {
            name: /start/i,
        });
        expect(startButtonsAfter.length).toBe(3);
    });
});
