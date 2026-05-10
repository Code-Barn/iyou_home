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

Unit tests for the Rust backend are located in `src-tauri/src/lib.rs`. These tests directly call the `toggle_service_logic` function to verify service state transitions (start, stop, invalid action) without requiring a full Tauri runtime, ensuring robust and isolated testing.

To run the Rust tests:
```bash
cd src-tauri
cargo test
```

## Frontend (React)

The frontend is a React application located in the `src` directory.

*   **Main Component:** The main UI is defined in `src/App.tsx`.
*   **Communicating with the Backend:** The frontend uses the `@tauri-apps/api/core` package to `invoke` commands exposed by the Rust backend.
*   **Styling:** CSS is used for styling and is located in `src/App.css`.

### Testing the Frontend

The frontend is tested using [Vitest](https://vitest.dev/) and [@testing-library/react](https://testing-library.com/docs/react-testing-library/intro/). The test files are located in the `src/__tests__` directory.

The tests for the `App` component (`src/__tests__/App.test.tsx`) verify that the UI renders correctly and that user interactions trigger the expected Tauri commands. The `@tauri-apps/api/core` `invoke` function is mocked to isolate the frontend components from the Rust backend during testing.

To run the frontend tests, use the following command from the project root:
```bash
npm test
```
To run the tests with coverage, use:
```bash
npm run coverage
```

## Building for Production

To build the application for production, run:
```bash
npm run tauri build
```
This will create a standalone executable for your platform in the `src-tauri/target/release/bundle` directory.
