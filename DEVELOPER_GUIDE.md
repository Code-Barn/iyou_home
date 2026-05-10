# Developer Guide

This guide provides instructions for setting up the development environment, running the application, and understanding the project structure.

## Getting Started

### Prerequisites

*   [Rust](https://www.rust-lang.org/tools/install) and Cargo
*   [Node.js](https://nodejs.org/) and npm
*   Tauri v2 development prerequisites (see the [official Tauri documentation](https://beta.tauri.app/develop/prerequisites/))

### Installation and Running

1.  **Clone the repository:**
    ```bash
    git clone <repository-url>
    cd iyou-home
    ```

2.  **Install frontend dependencies:**
    ```bash
    npm install
    ```

3.  **Run the application in development mode:**
    ```bash
    npm run tauri dev
    ```
    This will start the frontend development server and the Tauri application, with hot-reloading enabled for both.

## Backend (Rust)

The backend is located in the `src-tauri` directory.

*   **Main Logic:** The core application logic is in `src-tauri/src/lib.rs`.
*   **Tauri Commands:** Rust functions exposed to the frontend are defined using the `#[tauri::command]` attribute.
*   **State Management:** Application state is managed using Tauri's `State` management feature. The `ServiceState` struct holds the status of the different services.

### Testing the Backend

To run the Rust tests:
```bash
cd src-tauri
cargo test
```
*(Note: No backend tests have been written yet.)*

## Frontend (React)

The frontend is a React application located in the `src` directory.

*   **Main Component:** The main UI is defined in `src/App.tsx`.
*   **Communicating with the Backend:** The frontend uses the `@tauri-apps/api/core` package to `invoke` commands exposed by the Rust backend.
*   **Styling:** CSS is used for styling and is located in `src/App.css`.

### Testing the Frontend

To run the frontend tests:
```bash
npm test
```
*(Note: No frontend tests have been written yet.)*

## Building for Production

To build the application for production, run:
```bash
npm run tauri build
```
This will create a standalone executable for your platform in the `src-tauri/target/release/bundle` directory.
