# iYou Home Architecture Audit Report

## Executive Summary

This audit identifies several critical gaps in the current implementation of persona management and key signing functionality. While the core infrastructure is solid, there are missing features that prevent the application from meeting user expectations for persona switching and key selection.

## Current State Analysis

### 1. Persona Management

**Current Implementation:**

- ✅ Users can create new personas via `add\_profile()` command

- ✅ Personas are stored in the vault with unique derivation indices

- ✅ Each persona gets a deterministic DID based on root seed + derivation index

- ✅ Personas are displayed in the UI with their names and truncated DIDs

**Missing Features:**

- ❌ **Persona Switching**: No UI or backend mechanism to switch between personas

- ❌ **Active Persona Persistence**: Active persona state is not saved between app restarts

- ❌ **Persona Removal UI**: While backend supports `remove\_profile()`, there's no UI to remove personas

- ❌ **Persona Selection for Operations**: No way to choose which persona to use for signing operations

### 2. Key Signing Functionality

**Current Implementation:**

- ✅ Basic signing works with the active DID

- ✅ Multiple signing endpoints exist (auth challenges, Nostr events, credentials)

- ✅ WebSocket-based signing requests work through the popup

- ✅ Profile ID can be passed to signing commands (but not exposed in UI)

**Missing Features:**

- ❌ **Key Selection UI**: No dropdown or selector to choose which key/persona to sign with

- ❌ **Automatic Key Switching**: Keys don't automatically switch based on context

- ❌ **Saved State**: Signing preferences are not persisted between sessions

- ❌ **Default Key Management**: No concept of setting a default key for different operation types

### 3. State Persistence

**Current Implementation:**

- ✅ Vault data (root seed, profiles) is persisted to `vault.json`

- ✅ Service auto-start settings are persisted to `auto\_start.json`

- ✅ Poll vote ledger is persisted to `poll\_ledger.json`

**Missing Features:**

- ❌ **Active Persona State**: Which persona is active is not saved

- ❌ **Signing Preferences**: User preferences for key selection are not stored

- ❌ **UI State**: Tab selection and other UI preferences are not persisted

## Technical Findings

### Backend Analysis (Rust)

**vault.rs:**

- `get\_active\_did()` always returns the first profile if no active DID is set

- No mechanism to set/change active profile

- `resolve\_profile\_keypair()` defaults to empty string (first profile) if no profile\_id provided

- Profile switching logic is completely missing

**lib.rs:**

- `sign\_auth\_challenge()` accepts optional `profile\_id` parameter but no UI exposes it

- `submit\_ws\_response()` and other WS handlers accept `profile\_id` but default to None

- No commands to explicitly set active profile or switch between personas

### Frontend Analysis (React/TypeScript)

**KeysManager.tsx:**

- Shows list of personas but no way to switch between them

- Creating new personas automatically makes them active

- No UI controls for persona selection or management

**SovereignSigner.tsx:**

- Always uses `get\_active\_did()` - no key selection

- No dropdown or selector for choosing signing identity

- Hardcoded to use whatever is returned as active DID

**WsSignPopup.tsx:**

- Receives `profile\_id` in requests but no UI to select it

- Auto-sign feature exists but no persona selection

- Signing requests don't show which persona will be used

## Recommended Architecture Changes

### 1. Persona Switching Implementation

**Backend Changes Required:**

```
// Add to lib.rs  
\#\[tauri::command\]  
fn set\_active\_profile(app: AppHandle, state: State\<'\_, ServiceState\>, profile\_id: String) -\> Result\<(), String\> \{  
    let vault = vault::load\_vault(&app)?;  
    if vault::get\_profile\_by\_id(&vault, &profile\_id).is\_none() \{  
        return Err(format!("Profile not found: \{\}", profile\_id));  
    \}  
    let mut active = state.active\_did.lock().unwrap();  
    if let Some(profile) = vault::get\_profile\_by\_id(&vault, &profile\_id) \{  
        \*active = Some(profile.did.clone());  
    \}  
    Ok(())  
\}  
  
// Add to vault.rs  
pub fn save\_active\_profile(app: &AppHandle, profile\_id: &str) -\> Result\<(), String\> \{  
    let mut path = app.path().app\_local\_data\_dir().unwrap\_or\_else(|\_| PathBuf::from("."));  
    path.push("active\_profile.txt");  
    fs::write(&path, profile\_id).map\_err(|e| format!("Failed to save active profile: \{\}", e))?;  
    Ok(())  
\}  
  
pub fn load\_active\_profile(app: &AppHandle) -\> Option\<String\> \{  
    let mut path = app.path().app\_local\_data\_dir().unwrap\_or\_else(|\_| PathBuf::from("."));  
    path.push("active\_profile.txt");  
    fs::read\_to\_string(&path).ok()  
\}
```

**Frontend Changes Required:**

```
// Add to KeysManager.tsx  
const handleSetActiveProfile = async (profileId: string) =\> \{  
    try \{  
        await invoke("set\_active\_profile", \{ profileId \});  
        await fetchActiveDid();  
    \} catch (err: any) \{  
        setError(err.toString());  
    \}  
\};  
  
// Add radio buttons or select dropdown next to each persona  
\<button onClick=\{() =\> handleSetActiveProfile(p.profile\_id)\}\>  
    \{p.did === activeDid ? 'Active' : 'Set Active'\}  
\</button\>
```

### 2. Key Selection for Signing Operations

**Backend Changes Required:**

- Modify signing commands to respect profile\_id parameter

- Add user preferences storage for default signing profiles

- Implement profile-specific signing logic

**Frontend Changes Required:**

```
// Add to SovereignSigner.tsx  
const \[selectedProfileId, setSelectedProfileId\] = useState\<string | null\>(null);  
const \[profiles, setProfiles\] = useState\<Profile\[\]\>(\[\]);  
  
useEffect(() =\> \{  
    const fetchProfiles = async () =\> \{  
        const list = await invoke\<Profile\[\]\>("list\_profiles");  
        setProfiles(list);  
    \};  
    fetchProfiles();  
\}, \[\]);  
  
// Add dropdown selector  
\<select  
    value=\{selectedProfileId || ""\}  
    onChange=\{(e) =\> setSelectedProfileId(e.target.value || null)\}  
\>  
    \<option value=""\>Default (Active Identity)\</option\>  
    \{profiles.map((p) =\> (  
        \<option key=\{p.profile\_id\} value=\{p.profile\_id\}\>  
            \{p.profile\_name\} (\{truncateDid(p.did)\})  
        \</option\>  
    ))\}  
\</select\>  
  
// Modify sign command  
const handleSign = async (e: React.FormEvent) =\> \{  
    // ... existing code ...  
    const vpJson = await invoke\<string\>("sign\_auth\_challenge", \{  
        challenge: challenge,  
        didId: activeDid,  
        profileId: selectedProfileId || undefined  
    \});  
\}
```

### 3. State Persistence Implementation

**Backend Changes Required:**

```
// Add to lib.rs setup  
\#\[tauri::command\]  
fn get\_user\_preferences(app: AppHandle) -\> Result\<serde\_json::Value, String\> \{  
    let mut path = app.path().app\_local\_data\_dir().unwrap\_or\_else(|\_| PathBuf::from("."));  
    path.push("preferences.json");  
    if !path.exists() \{  
        let default\_prefs = serde\_json::json!(\{  
            "defaultSigningProfile": "",  
            "autoSign": false,  
            "lastActiveTab": "services"  
        \});  
        std::fs::write(&path, default\_prefs.to\_string()).map\_err(|e| e.to\_string())?;  
        return Ok(default\_prefs);  
    \}  
    let content = std::fs::read\_to\_string(&path).map\_err(|e| e.to\_string())?;  
    serde\_json::from\_str(&content).map\_err(|e| e.to\_string())  
\}  
  
\#\[tauri::command\]  
fn save\_user\_preferences(app: AppHandle, preferences: serde\_json::Value) -\> Result\<(), String\> \{  
    let mut path = app.path().app\_local\_data\_dir().unwrap\_or\_else(|\_| PathBuf::from("."));  
    path.push("preferences.json");  
    std::fs::write(&path, preferences.to\_string()).map\_err(|e| e.to\_string())?;  
    Ok(())  
\}
```

**Frontend Changes Required:**

```
// Add to App.tsx  
const \[activeTab, setActiveTab\] = useState\<"services" | "keys" | "signer"\>("services");  
const \[preferences, setPreferences\] = useState\<any\>(null);  
  
useEffect(() =\> \{  
    const loadPreferences = async () =\> \{  
        try \{  
            const prefs = await invoke\<any\>("get\_user\_preferences");  
            setPreferences(prefs);  
            if (prefs.lastActiveTab) \{  
                setActiveTab(prefs.lastActiveTab);  
            \}  
        \} catch (error) \{  
            console.error("Failed to load preferences:", error);  
        \}  
    \};  
    loadPreferences();  
\}, \[\]);  
  
useEffect(() =\> \{  
    if (preferences) \{  
        const savePreferences = async () =\> \{  
            try \{  
                await invoke("save\_user\_preferences", \{  
                    preferences: \{ ...preferences, lastActiveTab: activeTab \}  
                \});  
            \} catch (error) \{  
                console.error("Failed to save preferences:", error);  
            \}  
        \};  
        savePreferences();  
    \}  
\}, \[activeTab\]);
```

## Implementation Priority

### High Priority (Blockers)

1. **Persona Switching UI** - Users need to be able to switch between created personas

2. **Active Persona Persistence** - Selected persona should persist across app restarts

3. **Key Selection Dropdown** - Users need to choose which key to sign with

### Medium Priority (Enhancements)

1. **Default Profile Preferences** - Set default profiles for different operation types

2. **Persona Management UI** - Add remove/edit functionality for personas

3. **Signing Request Context** - Show which persona will be used in signing popups

### Low Priority (Nice-to-have)

1. **UI State Persistence** - Remember tab selection and other UI preferences

2. **Advanced Auto-sign Rules** - Profile-specific auto-sign preferences

3. **Persona Import/Export** - Backup and restore individual personas

## Security Considerations

1. **Profile ID Validation**: Ensure profile\_id parameters are validated to prevent injection

2. **Active Profile Sanity Checks**: Verify profile exists before setting as active

3. **Preference File Permissions**: Ensure user preference files have appropriate permissions

4. **Backup Compatibility**: Ensure new state files don't break existing vault compatibility

## Testing Requirements

1. **Unit Tests**: Add tests for new profile switching and preference functions

2. **Integration Tests**: Test persona switching flow end-to-end

3. **Persistence Tests**: Verify state survives app restarts

4. **Edge Case Tests**: Test with empty profiles, invalid profile IDs, etc.

5. **UI Tests**: Verify all new UI elements work correctly

## Migration Path

1. **Backward Compatibility**: All changes should be backward compatible

2. **Default Behavior**: Existing behavior should remain unchanged if new features aren't used

3. **Data Migration**: No migration needed - new state files will be created on first use

4. **Feature Flags**: Consider feature flags for gradual rollout of new functionality

## Conclusion

The current architecture is sound but lacks the persona switching and key selection features that users expect. The recommended changes are modest in scope and can be implemented incrementally without disrupting existing functionality. The highest priority should be given to persona switching and key selection UI, followed by state persistence improvements.

