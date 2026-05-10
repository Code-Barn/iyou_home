import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import App from "../App";
import { invoke } from "@tauri-apps/api/core";

// Mock the invoke function from Tauri
vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(),
}));

describe("App", () => {
    it("renders the service switch panel", () => {
        render(<App />);
        expect(screen.getByText("Service Switch Panel")).toBeInTheDocument();
        expect(screen.getByText("Nostr")).toBeInTheDocument();
        expect(screen.getByText("Blossom")).toBeInTheDocument();
        expect(screen.getByText("IPFS")).toBeInTheDocument();
    });

    it("calls the toggle_service command when a button is clicked", async () => {
        (invoke as any).mockResolvedValue("running");
        render(<App />);

        const nostrButton = screen.getAllByRole("button", {
            name: /start/i,
        })[0];
        fireEvent.click(nostrButton);

        await waitFor(() => {
            expect(invoke).toHaveBeenCalledWith("toggle_service", {
                name: "Nostr",
                action: "start",
            });
        });

        // Check if the status and button text updated
        expect(await screen.findByText("Stop")).toBeInTheDocument();
    });

    it("handles service stop correctly", async () => {
        // First call for "start" should return "running"
        (invoke as any).mockResolvedValueOnce("running");
        // Second call for "stop" should return "stopped"
        (invoke as any).mockResolvedValueOnce("stopped");

        render(<App />);

        // First, click to "start" the service and update the state
        const startButton = screen.getAllByRole("button", {
            name: /start/i,
        })[0];
        fireEvent.click(startButton);

        // Wait for the button text to change to "Stop"
        const stopButton = await screen.findByText("Stop");

        // Now, click the "Stop" button
        fireEvent.click(stopButton);

        await waitFor(() => {
            // The second call to invoke
            expect(invoke).toHaveBeenCalledWith("toggle_service", {
                name: "Nostr",
                action: "stop",
            });
        });

        // Check if the button text updated back to "Start"
        // We need to use getAllByRole because "Start" is present for the other services
        const startButtons = await screen.findAllByRole("button", {
            name: /start/i,
        });
        expect(startButtons.length).toBe(3);
    });
});
