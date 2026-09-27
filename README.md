# File Transfer

File Transfer sends files from a phone's browser directly to a Windows or Linux PC over a local Wi-Fi network. It accepts **any file the browser lets you select**: documents, archives, audio, photos, videos, files with unknown extensions, and more. There is no extension or MIME allowlist, mobile app, cloud service, account, analytics, or telemetry.

The phone and PC must be able to reach each other on the same network. A phone hotspot with the PC connected to it is one way to do this.

## Requirements

- A recent Node.js LTS release (22 or 24)
- pnpm 11
- Windows 11 or a modern Linux system

## Install and run

```sh
pnpm install
pnpm dev
```

For the compiled version:

```sh
pnpm build
pnpm start
```

The terminal prints the destination folder, one or more local URLs, and a QR code. On the PC, `http://127.0.0.1:8080/admin` shows the QR code and the current session history. Keep the server running while transferring files.

## Send files from a phone

1. Connect the PC to the phone's hotspot, or put both devices on the same reachable Wi-Fi network.
2. Start File Transfer on the PC.
3. Scan the QR code with the phone. Its session URL opens an authorized browser session; the token changes when the server restarts.
4. Tap **Choisir des fichiers**, select one or more files, then tap **Envoyer vers le PC**.
5. Wait for **Fichier vérifié — SHA-256 identique** on each file. Use **Réessayer les erreurs** if a transfer fails. The app resumes from the last block confirmed by the PC.

After a page reload or a server restart, scan the current QR code again if needed, select the **same file**, and start the transfer. The browser keeps only the transfer ID in local storage; it cannot reopen a file from the phone without your selection. A new server start changes the authorization token but restores eligible partial transfers from disk.

The file input has no `accept` filter. The operating system or mobile browser still controls which files its picker can expose. Some photo libraries hand the browser an exported version of a photo; the app can only transfer and verify the bytes the browser actually supplies. Folder selection and bidirectional transfer are not part of this version.

If the phone cannot open the page, try another address shown in the terminal, check that the PC firewall allows Node.js on the private network, and check whether the hotspot isolates connected devices.

## Integrity and storage

The browser calculates the whole-file SHA-256 and per-block SHA-256 values in 4 MiB chunks inside a Web Worker. A main-thread fallback is used if Workers are unavailable. This keeps the interface responsive without loading a large file into memory. The server streams each block into a temporary file and verifies its size and SHA-256 before committing the new offset. On completion, it streams the temporary file once more to verify the whole-file SHA-256 before publishing the final file. The extra disk read is needed to verify a transfer resumed after a server restart.

An interrupted or incorrect block is rolled back to the last confirmed offset. Partial transfers are retained for up to seven days so they can be resumed. Expired transfers are cleaned at startup and during server operation; unrecoverable orphaned temporary files are also cleaned. A final checksum mismatch deletes the partial transfer. Files already present are never silently overwritten: `report.pdf` becomes `report_1.pdf`, then `report_2.pdf`, and so on. File names are sanitized so they cannot escape the destination folder.

Before creating a transfer, the server checks available disk space when the operating system provides it and reserves the remaining size of other partial transfers. It rejects an upload with a clear disk-space error when there is insufficient space. A different process could still fill the disk later; write errors leave the confirmed offset intact for a later retry.

The application never decodes, recompresses, resizes, converts, or re-encodes file content. It transfers the browser-provided bytes unchanged, preserving any metadata embedded in those bytes, including EXIF, XMP, ICC profiles, document metadata, and video metadata.

The original name, byte size, browser-provided MIME type, browser-provided last-modified time when available, and SHA-256 travel with each file. The app attempts to restore the filesystem modification time. Browsers may omit or synthesize that time; the filesystem creation time is not guaranteed. MIME type is retained in the current session's API history, not written into the file contents.

By default, files go to `~/FileTransfer`. The local `.env` in this workspace retains `C:/Users/nicol/PhoneTransfer` so previously received files stay in the same folder. Change `FILE_TRANSFER_DESTINATION` to use another location.

## Security

A fresh random 192-bit token is generated at every server start. The QR URL contains that token. The server exchanges it for an `HttpOnly`, `SameSite=Strict` session cookie, then redirects the browser to remove the token from the visible URL. Upload and other API routes require the session. The `/admin` page is only available from the PC itself.

Keep the QR code private. Transfer traffic uses HTTP on the local network, so use a trusted, protected hotspot or Wi-Fi network. Disabling authentication is intended only for a network you fully control. No Internet connection is needed for transfers after dependencies are installed.

## Configuration

Edit the real `.env` file in the project root. It is loaded automatically and ignored by Git. `.env.example` is a shareable template. Environment variables already set in the terminal take precedence over values in `.env`.

| Variable | Default when unset | Purpose |
| --- | --- | --- |
| `FILE_TRANSFER_PORT` | `8080` | HTTP port |
| `FILE_TRANSFER_HOST` | `0.0.0.0` | Listen address; `127.0.0.1` limits access to the PC |
| `FILE_TRANSFER_DESTINATION` | `~/FileTransfer` | Destination folder |
| `FILE_TRANSFER_CONCURRENCY` | `2` | Maximum simultaneous uploads, from 1 to 8 |
| `FILE_TRANSFER_MAX_BYTES` | No application limit | Optional per-file limit in bytes |
| `FILE_TRANSFER_AUTH` | `true` | Enable the QR-token session check |

The previous `PHOTO_TRANSFER_*` variable names remain accepted as fallbacks. If both forms are set, `FILE_TRANSFER_*` takes precedence.

Example on PowerShell: `$env:FILE_TRANSFER_DESTINATION='D:\Files\FromPhone'; pnpm dev`.

Example on Linux: `FILE_TRANSFER_DESTINATION="$HOME/FromPhone" pnpm dev`.

## Project layout and API

- `src/index.ts`: startup, local URLs, and terminal QR code.
- `src/server/`: Fastify routes, session authorization, and network address selection.
- `src/services/`: environment configuration, streaming and resumable storage, disk checks, and SHA-256 validation.
- `src/utils/filename.ts`: safe file names and collision handling.
- `public/`: mobile page, hashing Web Worker, and PC admin page in plain HTML, CSS, and JavaScript.
- `tests/`: binary integrity, file type, filename, collision, authentication, resume, disk-space, cleanup, and browser SHA-256 tests.

Authenticated routes:

- `GET /api/status`: server status, destination, available disk space when supported, and session counts.
- `GET /api/files`: files received during this server session.
- `POST /api/uploads`: create a resumable transfer after validating metadata and available space.
- `GET /api/uploads/:id`: obtain the last confirmed offset or completion receipt.
- `POST /api/uploads/:id/chunk`: send one multipart block with offset, byte length, and SHA-256 headers.
- `POST /api/uploads/:id/complete`: verify the entire file and publish it.
- `POST /api/upload`: legacy single-request upload endpoint, retained for compatibility.

## Tests

```sh
pnpm test
```

The server uses streams and does not buffer an entire upload in memory. The browser hashes one file in chunks before uploading it; very large files can therefore take time before their upload begins. Resume works at confirmed block boundaries, so at most the interrupted block needs to be sent again. The phone's browser must make the same file available again after a page reload.
