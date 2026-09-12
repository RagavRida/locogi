# Locogi Mobile App

Chat-first React Native app built with Expo. The entire app is a single conversation
with the Locogi agent — cards render inline in the chat, no traditional home screen.

## Run it on your phone (2 minutes)

### 1. Install Expo Go on your phone
- **iOS:** App Store → search "Expo Go"
- **Android:** Play Store → search "Expo Go"

### 2. Install dependencies

```bash
cd apps/mobile
npm install
```

### 3. Point the app at your backend

Open `app.json` and set `extra.apiUrl`:

```json
"extra": {
  "apiUrl": "http://192.168.1.5:3000"
}
```

**Important:** use your computer's LAN IP, not `localhost`.
`localhost` on your phone means the phone itself, not your dev machine.

Find your IP:
- **macOS:** `ipconfig getifaddr en0`
- **Windows:** `ipconfig` → look for IPv4 Address
- **Linux:** `hostname -I`

### 4. Start the dev server

```bash
npx expo start
```

A QR code appears in your terminal.

### 5. Scan it
- **iOS:** open Camera app → point at QR code → tap the banner
- **Android:** open Expo Go → tap "Scan QR code"

The app loads on your phone. Edit any file and it hot-reloads instantly.

---

## Architecture

```
App.tsx                       Navigation root
├── LoginScreen               Phone + OTP (pre-auth)
├── RoleScreen                Customer / Vendor / Both (first launch)
└── ChatScreen                ← THE ENTIRE APP
    │
    ├── Chat thread (messages + inline cards)
    │   ├── ConfirmationCard  Edit LLM-extracted fields
    │   ├── FollowUpCard      Category-specific questions
    │   ├── SearchingCard     Animated radar while matching
    │   ├── VendorListCard    Matched vendors
    │   ├── QuoteCard         Accept / counter a price
    │   ├── SlotPickerCard    Appointment booking
    │   ├── JobTrackerCard    4-stage progress
    │   ├── ReviewCard        Star rating
    │   └── RebookCard        Book same vendor again
    │
    ├── HistoryScreen         Past requests (header icon)
    ├── SettingsScreen        Profile, permissions (avatar tap)
    └── VendorInboxScreen     Incoming jobs (vendor mode only)
```

## Key files

| File | Purpose |
|---|---|
| `src/screens/ChatScreen.tsx` | The whole app — chat + card orchestration |
| `src/api/client.ts` | Typed API client with SecureStore token handling |
| `src/store/index.ts` | Zustand store — messages, auth, active flow state |
| `src/hooks/useCategoryQuestions.ts` | Category-specific follow-up logic |
| `src/theme/index.ts` | Design tokens (dark + electric lime accent) |

## Testing without a backend

The app calls a real API. To test the UI standalone, stub the client:

```ts
// src/api/client.ts — temporarily replace api.extractRequest
extractRequest: async (text: string) => ({
  categoryTags: ['Photography'],
  attributes: { area: 'Madhapur', budget: 5000, hours: 3 },
  attributeSchema: { area: 'text', budget: 'currency', hours: 'number' },
  bookingTypeSuggestion: 'quote' as const,
  ambiguityFlag: false,
  ambiguityNote: null,
  followUpQuestions: [],
}),
```

## Build for stores (later)

```bash
npm install -g eas-cli
eas login
eas build:configure
eas build --profile preview --platform all   # TestFlight + Play internal
```
