# File Transfer

Send photos and other files from your phone to your PC over the local network.

## Start the server

With Node.js 22 or later and pnpm installed, run these commands in the project folder:

```sh
pnpm install
pnpm dev
```

The terminal displays the QR code. You can also open [the PC page](http://127.0.0.1:8080/admin) to see the QR code and received files.

## Send files

1. Connect your phone and PC to the same Wi-Fi network or hotspot.
2. Scan the QR code. Tap **Choisir des photos et vidéos** for your gallery or **Choisir des fichiers** to browse all files, then tap **Envoyer vers le PC**.
3. Wait for **Fichier vérifié**. The received files are saved in `output/` in the project folder.

If the gallery returns without adding files, use **Choisir des fichiers**, then **Fichiers** or **Parcourir** to select a copy stored on your phone.

If a transfer stops, tap **Réessayer les erreurs**. After a page reload or server restart, select and send the same file again to resume. Scan the new QR code if the server restarted.

To change the destination or port, copy the relevant settings from `.env.example` into `.env`.
