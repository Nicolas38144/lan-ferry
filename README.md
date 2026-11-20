# File Transfer

Send photos and other files from your phone to your PC over the local network.

## Start the server

With Node.js 22.13 or later and [pnpm](https://pnpm.io/installation) installed, run these commands in the project folder:

```sh
pnpm install --frozen-lockfile
pnpm run dev
```

If PowerShell finds an old Corepack launcher first and your pnpm installation is in `%APPDATA%\npm`, put that directory first for the current session, then rerun the commands above.

```powershell
$env:Path = "$env:APPDATA\npm;$env:Path"
```

The terminal displays the QR code. You can also open [the PC page](http://127.0.0.1:8080/admin) to see the QR code and received files.

## Send files

1. Connect your phone and PC to the same Wi-Fi network or hotspot.
2. Scan the QR code. Tap **Choisir plusieurs fichiers** and select a batch under **Fichiers** or **Parcourir**. You can also use **Ajouter depuis la galerie**.
3. Check the selection, then tap **Envoyer vers le PC**. Wait for **Fichier vérifié**. The received files are saved in `output/` in the project folder.

If videos are missing from the gallery, try **Choisir des vidéos** or browse for the local files through **Fichiers** or **Parcourir**. If the gallery closes after each choice, reopen it to keep adding items to the same list.

If a transfer stops, tap **Réessayer les erreurs**. After a page reload or server restart, select and send the same file again to resume. Scan the new QR code if the server restarted.

To change the destination or port, copy the relevant settings from `.env.example` into `.env`.
