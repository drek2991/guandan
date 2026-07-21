# Mobile

Minimal iPhone client scaffold built with Expo SDK 54, React Native, TypeScript, and Expo Router. It uses Expo's managed workflow and runs in Expo Go without a custom development client.

From the repository root, install dependencies and start Metro:

```sh
npm install
npm run mobile:start
```

Scan the development-server QR code with Expo Go on an iPhone connected to the same network.

Run TypeScript validation from the root with:

```sh
npm run mobile:typecheck
```

## Public environment values

Future values exposed to mobile JavaScript must use the `EXPO_PUBLIC_` prefix and static dot notation such as `process.env.EXPO_PUBLIC_API_BASE_URL`. Expo includes these values in the application bundle, so they are public and must never contain database credentials, service-role keys, passwords, signing secrets, or reconnect credentials.

The example API base URL is optional and currently unused. The mobile scaffold does not make network requests or connect to the server or Supabase.
