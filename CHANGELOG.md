# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semantic-versioning.org/spec/v2.0.0.html).

## [Unreleased]

## [v3.0.0] - 2024-MM-DD

### 🎉 New Features

#### Multi-Persona Architecture
- **Complete persona management system** with multiple identities per user
- **Profile creation** with unique derivation indices and DIDs
- **Profile switching** with persistent active profile selection
- **Profile deletion** with safety protections and confirmation dialogs
- **Visual active profile indicators** in UI with radio button style

#### Enhanced Signing Workflows
- **SovereignSigner**: Profile selection dropdown for manual signing
- **WsSignPopup**: Persona context display showing which identity will sign
- **Backend integration**: All signing commands now support optional `profile_id` parameter
- **Headless signing**: OMNI_SIGN_REQUEST supports explicit profile targeting

#### User Preferences System
- **Persistent user preferences** stored in `preferences.json`
- **Active profile persistence** across application restarts
- **Default signing profile** configuration
- **UI state persistence** (last active tab, etc.)

### 🔧 Backend Changes

#### New Tauri Commands
- `get_user_preferences()` - Load current user preferences
- `save_user_preferences(preferences)` - Save updated preferences
- `set_active_profile(profile_id)` - Switch active persona with validation
- `remove_profile(profile_id)` - Delete persona with safety checks

#### Enhanced Existing Commands
- `get_active_did()` - Now consults preferences before falling back to primary
- `sign_auth_challenge()` - Accepts optional `profile_id` parameter
- `submit_ws_response()` - Passes `profile_id` to backend
- `submit_ws_event_response()` - Passes `profile_id` to backend
- `submit_ws_credential_response()` - Passes `profile_id` to backend

#### Data Structures
- **UserPreferences struct** with serialization/deserialization
- **Enhanced Profile struct** with proper TypeScript/Rust compatibility
- **Preferences persistence** with proper error handling

### 🎨 Frontend Changes

#### KeysManager.tsx
- **Profile list with active indicators** (radio button style)
- **Delete persona functionality** with confirmation modal
- **Primary profile protection** (cannot delete primary)
- **Error handling** for all profile operations
- **Automatic profile loading** on component mount

#### SovereignSigner.tsx
- **Profile selection dropdown** for signing operations
- **Active profile auto-selection** on load
- **Profile-aware signing** passes selected profile to backend
- **Enhanced error handling** with user feedback

#### WsSignPopup.tsx
- **Persona context display** showing signing identity
- **Profile loading** on popup initialization
- **Active profile detection** for fallback scenarios
- **Request-specific profile display** from WebSocket messages

### 📝 Documentation

#### HOME_DEVELOPER_GUIDE.md
- **v3 Multi-Persona Architecture** section added
- **State persistence layout** documented
- **Critical behavioral patterns** explained
- **Headless bridge limitations** clearly documented
- **Greenfield-only policy** clarified
- **Multi-user isolation** behavior described

### 🔒 Security

#### No Backward Compatibility
- **Greenfield-only approach** eliminates technical debt
- **Clean reset** on any deserialization failure
- **No legacy migration code** to maintain
- **Simplified initialization** path

#### Enhanced Safety
- **Primary profile protection** (cannot be deleted)
- **Profile existence validation** before operations
- **Proper error handling** throughout
- **State shadowing fixes** in async contexts

#### Multi-User Isolation
- **Per-OS-user file storage** using `app_local_data_dir()`
- **Independent initialization** per user account
- **No cross-user data leakage**
- **Proper file permissions**

### 🧪 Testing

#### Backend Tests
- `test_preferences_round_trip` - Preferences serialization/deserialization
- `test_preferences_defaults` - Default values verification
- `test_profile_removal_fallback` - Safe profile removal
- `test_set_active_profile_validation` - Profile switching validation
- All existing vault tests still passing

#### Frontend Verification
- TypeScript compilation: ✅ 0 errors
- React component structure: ✅ Valid
- State management: ✅ No infinite loops
- Error boundaries: ✅ Comprehensive

### 📖 Breaking Changes

#### Architecture Shift
- **Dropped backward compatibility** with v1/v2 schemas
- **Greenfield reset only** - old `IdentityStore` schema removed
- **New preferences system** replaces ad-hoc settings
- **Profile-based signing** replaces single-identity model

#### Migration Path
For existing pre-release users (single user base):
1. Delete `vault.json` to trigger greenfield reset
2. Application will create new v3 schema automatically
3. Recreate personas as needed
4. All data is fresh and clean

### 🎯 Technical Highlights

#### Clean Architecture
- **Separation of concerns** between backend/frontend
- **Single responsibility principle** in components
- **Pure functions** where possible
- **Immutable state management**

#### Performance
- **Efficient profile loading** with caching
- **Minimal re-renders** in React components
- **Async operations** properly managed
- **No blocking operations** in hot paths

#### Code Quality
- **Comprehensive TypeScript types**
- **Rust error handling** with proper propagation
- **Clear function documentation**
- **Consistent naming conventions**

## [v2.0.0] - 2024-XX-XX

*(Previous version - initial multi-persona infrastructure)*

## [v1.0.0] - 2024-XX-XX

*(Initial release - single identity model)*