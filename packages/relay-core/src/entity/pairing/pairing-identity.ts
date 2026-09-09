export type PairingIdentityCredential =
    | { readonly kind: "host"; readonly channelId: string; readonly tokenHash: string }
    | { readonly kind: "daemon"; readonly channelId: string; readonly tokenHash: string }
    | { readonly kind: "project"; readonly projectId: string; readonly tokenHash: string }
    | { readonly kind: "pairing"; readonly pairingId: string; readonly tokenHash: string }
    | { readonly kind: "pairing-code"; readonly codeHash: string }
    | { readonly kind: "grant"; readonly channelId: string; readonly grantId: string; readonly secretHash: string };
