# Beam

Your phone's camera on any screen. Open the site on a computer, scan the code with a phone, tap
**Start camera**, and the picture shows up on the computer. No app, no account.

- Up to 4 phones per screen. Photos (full resolution where the phone allows), clips, mic audio.
- From the screen: take a photo, record a clip, switch camera, light, zoom, listen, mirror,
  picture-in-picture, full screen.
- Photos and clips stay in the screen's page (save or copy them); nothing is stored on the server.

## How it works

The server (`server/index.ts`) only pairs devices: it hands out 6-character codes and passes WebRTC
connection details between a phone and the screen. Video, audio and photos then go **directly**
between the two browsers, encrypted. When networks won't allow that, they go through the TURN relay
(coturn, shared with `task`), still end-to-end encrypted. The tile on the screen says which:
*Direct* or *Relayed*.

- `shared/protocol.ts`: every message, both through the server and on the direct data channel.
- `src/camera/store.ts`: the phone. Joins, calls the screen, recovers from sleep, reloads and drops.
- `src/screen/store.ts`: the screen. Holds the session, answers calls, collects photos and clips.
- Sessions survive a server restart (saved to `DATA_DIR`), and a call in progress doesn't need the
  server at all, so deploys don't interrupt anyone.

## Develop

```sh
pnpm install
pnpm dev          # pairing server on :8794 + Vite on http://localhost:6190
```

Phones need HTTPS for the camera, so test phones against the deployed site (or a tunnel); on the
computer, `localhost` counts as secure. `?relay` on a camera's address forces the TURN relay.

## Deploy

```sh
ssh root@162.35.161.214 'bash -s' < deploy/setup-vps.sh   # once: user, folders, Caddy block
./deploy.sh                                               # every time (Git Bash)
```

Live at https://cam.162-35-161-214.sslip.io. For https://cam.sraas.dev, add an A record at Porkbun
(host `cam`, answer `162.35.161.214`), then:

```sh
ssh root@162.35.161.214 'bash -s' < deploy/enable-domain.sh   # checks the record, adds the name to Caddy
```
