import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import App from '../App';
import { invoke } from '@tauri-apps/api/core';

// Mock the invoke function from Tauri
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('App', () => {
  it('renders the service switch panel', () => {
    render(<App />);
    expect(screen.getByText('Service Switch Panel')).toBeInTheDocument();
    expect(screen.getByText('Nostr')).toBeInTheDocument();
    expect(screen.getByText('Blossom')).toBeInTheDocument();
    expect(screen.getByText('IPFS')).toBeInTheDocument();
  });

  it('calls the toggle_service command when a button is clicked', async () => {
    (invoke as jest.Mock).mockResolvedValue('running');

    render(<App />);

    const nostrButton = screen.getAllByRole('button', { name: /start/i })[0];
    fireEvent.click(nostrButton);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('toggle_service', {
        name: 'Nostr',
        action: 'start',
      });
    });

    // Check if the status and button text updated
    expect(await screen.findByText('Stop')).toBeInTheDocument();
  });

  it('handles service stop correctly', async () => {
    // Set initial state to 'running' to test the stop action
    (invoke as jest.Mock).mockResolvedValue('stopped');

    render(<App />);

    // First, click to "start" the service and update the state
    const startButton = screen.getAllByRole('button', { name: /start/i })[0];
    fireEvent.click(startButton);

    // Wait for the button text to change to "Stop"
    const stopButton = await screen.findByText('Stop');

    // Now, click the "Stop" button
    fireEvent.click(stopButton);

    await waitFor(() => {
        expect(invoke).toHaveBeenCalledWith('toggle_service', {
            name: 'Nostr',
            action: 'stop',
        });
    });

    // Check if the status and button text updated back to "Start"
    expect(await screen.findByText('Start')).toBeInTheDocument();
  });
});
