# LAN Share

A self-hosted clipboard and file bridge for your local network. Move text and
images between your iPhone and your desktop without any cloud service — one
Node.js file, zero dependencies, no build step.

## Run it

```sh
node share.js
```

You need Node 16 or newer, nothing else. Flags:

```sh
node share.js --port 9090    # use another port (default 8080)
node share.js --pin 1234     # require a PIN once per browser
```

## Open it on your phone

1. Make sure the phone is on the **same Wi-Fi network** as the machine running
   `share.js` (a "guest" network usually won't reach it).
2. Look at the terminal — on startup it prints every address it's reachable
   on, e.g. `http://192.168.1.42:8080`.
3. Type that URL into Safari on the phone. That's it — anything you send from
   one device shows up on all the others within a second.

If the page doesn't load, your desktop firewall is probably blocking incoming
connections — allow Node when macOS asks, or add an inbound rule for the port
on Windows.

Tips on the phone: paste a photo straight into the page to upload it, use
**Take photo** to shoot and share in one step, and tap any text item to copy
it. HEIC photos are stored and served as-is (no preview on browsers that
can't decode them — use the Download link).

## What it keeps (and throws away)

- Items live in memory and files in a temp dir (`$TMPDIR/lanshare-<pid>`);
  **everything is deleted when you stop the server** and items expire on
  their own after 60 minutes.
- Caps: 200 MB per file, 1 GB total, 200 items. Oversized posts are rejected
  with an error, nothing is silently dropped.

## Security caveat — read this

The server binds to `0.0.0.0` and speaks **plain unencrypted HTTP**. Anyone
on the same network can open the page, read the whole feed, post to it, and
delete from it. `--pin` puts a lock on the door (asked once per browser,
then remembered in a cookie), but the traffic itself is still unencrypted —
someone sniffing the network can see what you transfer either way.

Fine on your home Wi-Fi. Do **not** run it on café/hotel/office networks you
don't trust, and don't port-forward it to the internet.

## Hacking on it

Everything is in `share.js`, laid out top to bottom: caps and timing
constants under "Config", then state, helpers, one handler per route, and the
entire web page (HTML/CSS/JS) as a template string at the end of the file.
Heads-up when editing the page: it lives inside a JS template literal, so
avoid backticks and `${ }` in the page's own script — the client code uses
plain string concatenation for that reason.
