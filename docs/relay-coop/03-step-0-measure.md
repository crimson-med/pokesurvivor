# Step 0: measure traffic

**Goal:** know how many bytes per second a guest costs, so the hosting choice
and the server limits rest on real numbers.

**Depends on:** nothing. **Estimate:** half a day. **Code changes:** none.

`G.Net.stats` already counts bytes (`sentBytes`, `recvBytes`, `jsonBytes`,
`binarySent`, see `js/net/net.js`).

## Steps

1. Start the local setup (emulator + `python3 -m http.server 8000`) and open a
   room with 2 players. 4 is better: use the other PC and extra browser
   profiles.
2. Play 10 minutes, including a rift and a boss wave.
3. In the host's console, at the start and at the end:

   ```js
   ({ t: performance.now(), ...G.Net.stats })
   ```

4. Do the same in one guest's console.
5. Write the results in the table below and commit this file.

## Results

| Run | Players | Minutes | Host sent (bytes/s per guest) | Guest sent (bytes/s) | Avg host message (bytes) | Peak note |
| --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |

Per guest: `(sentBytes_end - sentBytes_start) / seconds / guests`.
Average host message: `sentBytes delta / sent delta`.

## Done when

- The table has at least one 4 player run.
- The 256 KB message limit in [02-protocol.md](02-protocol.md#limits) is at least 20
  times the largest message seen. If not, raise it there.
- The traffic estimate in [09-step-6-deploy.md](09-step-6-deploy.md#cost) uses these numbers.
