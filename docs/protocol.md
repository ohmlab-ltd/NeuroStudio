# Neuro Studio wire protocol

The byte-level contract between Neuro Studio and a Neuro N6 board: what the board sends, what the app sends back, and how the bootloader is driven.

The app code is the source of truth:

| Area | Files |
| --- | --- |
| Framing, resync, main-process TLV routing | `electron/device/parser.cjs`, `electron/device/session.cjs` |
| The network link (framed commands, link key) | `electron/device/netlink.cjs`, `electron/device/session.cjs`, `src/state/linkKey.ts` |
| TLV decoding | `src/device/tlv.ts`, `src/state/device.ts`, `src/render/overlay.ts` |
| Host-to-device packets | `src/device/packets.ts`, `src/components/panels/*.tsx`, `src/components/WifiSettingsDialog.tsx` |
| Bootloader (DFU) | `electron/dfu/protocol.cjs`, `electron/dfu/session.cjs`, `src/device/dfu.ts` |

Where the code and this document disagree, the code is correct, and a change to the code updates this document.

Conventions:

- All multi-byte integers are little-endian unless stated otherwise. Types: `u8`, `u16`, `u32`, `i16`, `i32`, `f32` (IEEE 754 single).
- Nothing is aligned or padded. Several fields sit at odd offsets.
- "Normalised" means a `u16` where 0 is the left or top edge of the JPEG frame and 65535 is the right or bottom edge. Encode as `round(clamp(v, 0, 1) * 65535)`.
- `+N` in a layout is the byte offset from the start of the TLV value, or from the start of a repeated record where stated.

## 1. Transports

Every transport carries the same byte stream. The board sends vendor frames (section 2). The app sends control packets (section 5) on the same link.

### USB bulk

| VID:PID | Identity | Notes |
| --- | --- | --- |
| 0x1209:0x8008 | Application (pid.codes) | Tried first. |
| 0xCAFE:0x4013 | TinyUSB test pair | Application firmware before 0x1209:0x8008, and the FSBL. |

- The app opens interface 0 with libusb and claims it, detaching a kernel driver where the OS allows.
- Bulk IN endpoint 0x81 carries vendor frames to the host. Bulk OUT endpoint 0x01 carries control packets to the board.
- On every connect the host sends CLEAR_FEATURE(ENDPOINT_HALT) to both endpoints. The device must reset its data toggles when it gets this, as the USB spec requires.
- The connect loop skips a board whose interface 0 is a CDC interface (class 0x02 or 0x0A), which is what the FSBL, a CDC ACM serial port, presents. Interface 0 of the application must not be CDC. The app suspends every video session while it flashes.
- Each board is held by one window at a time. A window that is not pinned to a port takes the first matching board no other window holds, or reports that the board is in use.

Chunking, as it matters to a sender:

- The host keeps four 64 KiB bulk IN transfers in flight. A transfer completes when it is full or when a short packet arrives.
- End each vendor frame with a short packet. If the frame length is an exact multiple of wMaxPacketSize, send a zero-length packet (ZLP). Without this, the tail of the frame waits in the host until later data fills the transfer.
- The parser works on a byte stream, not on transfers. A frame may span several transfers and one transfer may hold several frames. ZLPs are fine and count as link activity.
- Write each frame contiguously. Do not start a new frame until the previous one is fully queued.

Silence watchdog: with "auto recover" on, the default, no IN data for 5 s (a ZLP counts) makes the host close and reopen the device. On the second silent cycle it also issues a USB port reset. After three silent reports with no data in between it restarts the whole USB transport, keeping the pinned board. A board that streams video over WiFi or Ethernet keeps data flowing on USB, a 1 Hz 0x20 announce being enough, or auto recover must be off.

### TCP

The board is the TCP server and the app is the client. The app sets TCP_NODELAY and gives up a connect attempt after 3 s, reporting it as a failed connect. It retries with a backoff of 200 ms to 2 s.

Link loss: the app turns on TCP keepalive with a 1 s idle time. A board that reset answers the first probe with RST, and one that vanished stops answering, so either way the link drops and the app reconnects. There is no TCP heartbeat, so a quiet link otherwise stays up. The exception is a link that has carried video since it connected: if it then delivers no bytes at all for 10 s, the app closes it and reconnects.

| Mode | Host | Port |
| --- | --- | --- |
| WiFi SoftAP | From the board's 0x20 announce over USB, else 192.168.10.1 | From the same source, else 5000 |
| Ethernet | 192.168.20.1 | 5000 |

A board streams over WiFi only on the network it hosts. A board that joins another network streams over USB only.

While the board is on USB the app learns that network: its address from 0x20 and its name and password from 0x24 (section 4). It keeps them in memory for the window, through the switch to WiFi, and forgets them when a new USB link comes up, which may be another board. A WiFi host or port named at launch (`--wifi-host`, `--wifi-port`) takes the place of the announced address.

### Link key

A board can require a link key: its sketch calls `WiFi.setLinkKey()`, or the key is stored with its WiFi settings (section 5). The first frame such a board sends on every TCP connection is camera-less, and its only TLV is 0x23 META_BOARD_CHALLENGE: 16 fresh random bytes. It sends nothing else until it is answered, and waits 10 s for one command, framed like any other (section 5):

```
+0  u32     magic   KEY0
+4  u8[32]  HMAC-SHA256(key, "N6LINK1" || challenge)
```

The key is the UTF-8 bytes of the text, 8 to 64 of them. The right answer attaches the host as usual. Anything else, or no answer in time, closes the connection. The key keeps other hosts on the network off the board; it does not encrypt the stream.

The app answers with the key it holds for the board's address. With none, it asks the user, and keeps the key for that address until the window closes. A board that closes the connection before sending anything after the answer has refused the key: the app forgets it and asks again, saying so. After the user cancels the question, the app does not ask about that board again until a transport is picked from the menu.

## 2. Vendor frame

```
+0   u32  magic        0x30564E44, bytes on the wire 44 4E 56 30 ("DNV0")
+4   u32  frame_id     passed through, never checked
+8   u32  meta_len     bytes of TLV metadata after the header, at most 2 MiB (2097152)
+12  u32  payload_len  bytes of JPEG after the metadata, at most 4 MiB (4194304), 0 allowed
+16  u32  flags        not read by the app; bit 0 = JPEG payload
+20       meta_len bytes of TLV records (section 3)
          payload_len bytes of JPEG
```

The header is 20 bytes. There is no checksum and no trailer. A frame with both lengths 0 is invalid.

Framing and resync:

- The parser scans for the magic at any byte offset and discards whatever precedes it.
- A header with `meta_len` over 2 MiB, `payload_len` over 4 MiB, or both lengths 0 is rejected. Scanning resumes one byte later.
- The parser waits until the whole frame is buffered. If more than 8 MiB piles up without a complete frame, it keeps the last 64 bytes and drops the rest.
- A corrupt length that is still inside the limits is not detected. The parser consumes that many bytes, then resyncs on the next magic.

JPEG payload rules (`payload_len > 0`):

- The payload must be at least 200 bytes, start with FF D8 and end with FF D9 as its last two bytes. No trailing padding.
- A payload that fails this check is dropped together with its metadata. Only a 0x50 audio record, which is extracted first, survives.
- The app reads the image size from the first SOF marker. A size change resizes the view. All normalised coordinates are relative to this JPEG.

Video delivery is newest-only. When several complete frames arrive in one receive chunk (one USB transfer or one TCP read), only the newest JPEG and its metadata are shown. The metadata of a coalesced frame is still delivered if it holds a per-packet TLV (below).

### Camera-less frames

A frame with `payload_len = 0` and `meta_len > 0` is a camera-less (meta-only) frame. Sensor-only boards, audio sketches and periodic announces use these.

- The main process reads 0x20, 0x40, 0x64 and 0x65 from camera-less frames. It reads 0x40, 0x64 and 0x65 only from camera-less frames: on a video frame they are ignored.
- 0x50 audio is read from every frame, camera-less or not.
- The rest of the metadata reaches the renderer's decoder only if the frame holds at least one per-packet TLV: 0x14, 0x15, 0x16, 0x17, 0x1A, 0x1B, 0x30, 0x51, 0x52, 0x53, 0x54, 0x60, 0x61, 0x62, 0x63, 0x66, 0x67, 0x70 or 0x71. Otherwise the frame is control-only and its other TLVs are ignored.
- Overlay TLVs from a camera-less frame are decoded but not drawn. The overlay only changes on video frames, so put overlay TLVs in the frame whose image they describe.

## 3. TLV encoding

```
+0  u8   type
+1  u16  length   value length in bytes, 0 to 65535
+3       value
```

- Records follow each other directly, with no alignment or padding.
- The walker continues while at least 3 bytes remain. If a record's value would run past `meta_len`, walking stops there and every later record is lost.
- Unknown types are skipped using `length`. A board may add new types without breaking older builds of the app.
- A record shorter than its minimum length is ignored. Where a count runs past the end of the record, boxes, keypoints, bindings and Terminal lines keep the entries that fit. Vision, evidence, labels, image classifier and tuning records are dropped whole.
- Send each type at most once per frame, except 0x0A and 0x0B (once per object), 0x17 (records are joined in order) and 0x67 (any number). Repeats of other types are not handled consistently: some are appended, some overwrite, and the main process reads only the first.
- Order does not matter, except that 0x70 must follow its result TLV.
- Text is UTF-8. Invalid bytes show as U+FFFD, and control characters other than tab, CR and LF are removed. Names, labels, warnings and QR or barcode text end at the first NUL. Terminal text (0x17, 0x71) drops NUL bytes and CR instead. The main process and the renderer decode text the same way.

## 4. TLV reference

Carrier codes: V is used only on a video frame, and a coalesced frame loses it. P is per-packet: it is used on every frame, video or camera-less. C is read only from camera-less frames. Names follow the device-side `META_*` names where the code cites them, and the app's `kMeta*` constants otherwise.

| Type | Name | Purpose | Carrier |
| --- | --- | --- | --- |
| 0x01 | META_INFERENCE_MS | Inference time | V |
| 0x02 | META_BOXES | Detection boxes | V |
| 0x03 | META_KEYPOINTS | Pose keypoints | V |
| 0x04 | META_BINDINGS | Skeleton edges between keypoints | V |
| 0x0A | META_ISEG_CLASSSTR | Class name for one box | V |
| 0x0B | META_ISEG_MASK | Instance mask for one box | V |
| 0x12 | META_WARNING | Red warning banner | V, or on a forwarded camera-less frame |
| 0x14 | META_TOF_FRAME_LEGACY | Fixed 4x4 ToF distances (legacy) | P |
| 0x15 | META_TOF_FRAME | Variable ToF distance grid | P |
| 0x16 | META_TOF_STATUS | Per-zone ToF range status | P |
| 0x17 | META_DEBUG_TEXT | Text for the Terminal panel | P |
| 0x18 | META_FOLLOW_TARGET | Person-follower lock and commands | V |
| 0x19 | META_DEBUG_TOF | ToF grid over video on or off | V |
| 0x1A | META_MAG_FRAME | Magnetometer reading | P |
| 0x1B | META_IMU_FRAME | IMU reading | P |
| 0x20 | META_BOARD_IPV4 | Address of the network the board hosts, over USB | C, or the newest video frame |
| 0x23 | META_BOARD_CHALLENGE | Link-key challenge | First TCP frame from a keyed board |
| 0x24 | META_BOARD_SOFTAP | Name and password of the network the board hosts, over USB | C |
| 0x30 | META_THERMAL_FRAME | Thermal image, or thermal announce | P |
| 0x40 | META_VD66_ISP_ENABLED | ISP panel mode | C |
| 0x50 | META_AUDIO_PCM | Live microphone audio | Every frame |
| 0x51 | META_AUDIO_CLASS | Audio classifier result | P |
| 0x52 | META_AUDIO_MEL | Log-mel spectrogram fed to the model | P |
| 0x53 | META_AUDIO_LABELS | Audio class names | P |
| 0x54 | META_IMAGE_CLASS | Image classifier result | P |
| 0x60 | META_VISION_ID | Which CV sketch is running | P |
| 0x61 | META_QR_FRAME | QR code results | P |
| 0x62 | META_BARCODE_FRAME | 1D barcode results | P |
| 0x63 | META_BLOB_FRAME | Colour blob result | P |
| 0x64 | META_CAM_CAPS | Manual camera controls available | C |
| 0x65 | META_TUNE_DESC | Live-tuning parameter list | C |
| 0x66 | META_APRILTAG | AprilTag detections and pose | P |
| 0x67 | META_EVENT | Board event record | P |
| 0x70 | META_EVIDENCE_CROP | Thumbnails for vision results | P |
| 0x71 | META_DEBUG_LOG | Numbered lines for the Terminal panel | P |

The vision records (0x60 to 0x63, 0x66 and 0x70) are per-packet, so a `count = 0` result that clears the Vision panel is not lost when its video frame is coalesced. Each record replaces the one before, so every one can be applied.

### 0x01 META_INFERENCE_MS

`u16` inference time in milliseconds. Length must be at least 2. Shown as "inf N ms".

### 0x02 META_BOXES

```
+0  u8  count
then count records of 10 bytes:
  +0  u16  xc      box centre x, normalised
  +2  u16  yc      box centre y, normalised
  +4  u16  w       width, normalised
  +6  u16  h       height, normalised
  +8  u8   score   confidence, 0 to 255 (decoded, not currently shown)
  +9  u8   cls     class index
```

A box's position in this list (0-based) is its `obj_id` for 0x0A and 0x0B. Boxes are stroked in colour 4. Mask shading uses colour `cls % 5`.

### 0x03 META_KEYPOINTS and 0x04 META_BINDINGS

```
0x03:  +0 u8 count, then count records of 7 bytes:
  +0  u8   id        keypoint id, referenced by 0x04
  +1  u8   color_id
  +2  u16  x         normalised
  +4  u16  y         normalised
  +6  u8   conf      0 to 255; the app hides keypoints below 30

0x04:  +0 u8 count, then count records of 3 bytes:
  +0  u8  a          keypoint id
  +1  u8  b          keypoint id
  +2  u8  color_id
```

A binding is drawn only when both keypoint ids exist in the same frame and both have a `conf` of at least 30. Colour ids: 0 head (green), 1 arms (blue), 2 trunk (magenta), 3 legs (orange), 4 box (red). Any other id is drawn white.

### 0x0A META_ISEG_CLASSSTR

```
+0  u8  obj_id   index of the box in 0x02
+1       name    UTF-8, length - 1 bytes
```

Length must be at least 2. A NUL terminator is allowed but not needed. The name is trimmed and becomes the label of box `obj_id`, counting boxes across every 0x02 record in the frame. It may come before or after 0x02.

### 0x0B META_ISEG_MASK

```
+0  u8   obj_id   index of the box in 0x02
+1  u8   w        mask width in cells, 1 to 255
+2  u8   h        mask height in cells, 1 to 255
+3  u16  nbytes   packed data length, normally ceil(w * h / 8)
+5       nbytes of 1 bpp mask data
```

Bit `i = y * w + x` is in byte `i >> 3`, at bit `i & 7` (LSB first). A 1 bit is the object. The mask is stretched over the rectangle of box `obj_id`, so it covers the box, not the whole frame. `w`, `h` and `nbytes` must be non-zero, and `5 + nbytes` must fit in the record. If a frame omits the mask while the box is still there, the app keeps drawing the last mask for that box index, as long as frames arrive less than 500 ms apart.

### 0x12 META_WARNING

UTF-8 text, length at least 1, trimmed. If a frame holds several, the last non-empty one is used. The text appears as a banner at the top right and stays up for 2.5 s after it was last received. An empty warning does not clear it.

### 0x15 META_TOF_FRAME

```
+0  u8   rows
+1  u8   cols
+2  u8   roi_size   SPADs per zone side (4, 8 or 16)
+3  u8   roi_step   SPAD pitch between zones
+4  u32  distance_mm[rows * cols]   zone z = row * cols + col
```

`rows * cols` must be non-zero and the length must be exactly `4 + 4 * rows * cols`. A distance of 0 means no reading. The app maps zone (row, col) onto the 16x16 SPAD array. It covers SPAD columns `col * roi_step` to `col * roi_step + roi_size - 1` and SPAD rows `15 - row * roi_step - roi_size + 1` to `15 - row * roi_step`. SPAD row 0 is drawn at the top, so zone row 0 is at the bottom.

### 0x16 META_TOF_STATUS

```
+0  u8  rows, +1 u8 cols, +2 u8 roi_size, +3 u8 roi_step   (same header as 0x15)
+4  u8  status[rows * cols]   VL53L1 RangeStatus, 0 = valid
```

The length must be exactly `4 + rows * cols`, and `rows` and `cols` must match the frame's 0x15. The app drops a status grid shaped unlike the distance grid, whichever record comes first, as it would misalign every zone. It keeps a valid grid with the ToF frame, but the current UI does not show it.

A 0x16 that is not a valid status record is read as Terminal text, as older firmware sent debug text in 0x16.

### 0x14 META_TOF_FRAME_LEGACY

0x14 holds exactly 64 bytes: 16 `u32` distances in mm, a 4x4 grid in row-major order, with no header. The app shows it as a fixed 4x4 grid.

When 0x14 is anywhere in a frame, the renderer reads the frame's other ToF records with the legacy numbering, whatever their order:

| Meaning | Legacy type | Type |
| --- | --- | --- |
| Distance grid | 0x14 | 0x15 |
| Status | 0x15 (ignored) | 0x16 |
| Debug text | 0x16 | 0x17 |

Firmware must not send 0x14.

### 0x17 META_DEBUG_TEXT

UTF-8 text, appended to the Terminal panel. NUL bytes, CR and control characters other than tab and LF are dropped. Several 0x17 records in one frame are joined in order, and a frame's text is taken as whole lines: a missing final newline is added, so the line shows at once and the next frame's text starts a new one. A character split across two frames shows as U+FFFD, so end each frame's text on a whole character. The app skips a frame's text when it is identical to the last text it appended, since a board may attach the same metadata to many video frames. Two identical prints in a row therefore show once, and of several lines published between two frames only the one attached shows. 0x71 carries every line; from a board's first 0x71 on, the app ignores its 0x17 until the next connection.

### 0x18 META_FOLLOW_TARGET

The length must be exactly 10.

```
+0  u16  xc            locked person's box centre x, normalised
+2  u16  yc            centre y, normalised
+4  i16  v_mms         forward velocity command, mm/s
+6  i16  omega_mrads   yaw rate command, mrad/s
+8  u16  d_mm          distance to the person, mm; 0 = no valid range
```

Send it only on a frame where a person is locked, with (xc, yc) inside one of that frame's 0x02 boxes. Positive `v_mms` is forward and positive `omega_mrads` is CCW. The app shows the values with their sign.

### 0x19 META_DEBUG_TOF

The length must be exactly 1: a `u8`, where non-zero means on. When the newest video frame carries 0x19 with a non-zero value, the app draws the latest ToF grid over the video. The user aligns the grid with scale and offset sliders.

### 0x1A META_MAG_FRAME and 0x1B META_IMU_FRAME

```
0x1A (length >= 16):  f32 x, f32 y, f32 z, f32 temperature_degC
0x1B (length >= 28):  f32 ax, ay, az (g), f32 gx, gy, gz (dps), f32 temperature_degC
```

The app does not assign a unit to the magnetic field and shows it without one.

### 0x20 META_BOARD_IPV4

The length must be exactly 8.

```
+0  u8[4]  ipv4   a, b, c, d in that order (network byte order)
+4  u32    port   TCP port
```

For example, 192.168.1.110:5000 is `C0 A8 01 6E 88 13 00 00`. A board that streams over the network it hosts sends this over USB at about 1 Hz. The app reads it only over USB and connects there when WiFi is picked (section 1). A port of 0 or above 65535, or the address 0.0.0.0, is ignored as if the record were absent.

### 0x24 META_BOARD_SOFTAP

The network the board hosts, so the user can join it.

```
+0  u8   ssid_len   1 to 32
+1       ssid_len bytes of SSID
then:
    u8   pass_len   8 to 64
         pass_len bytes of passphrase
```

- The board sends it over USB only, about once a second, on a camera-less frame of its own, while it hosts its network and no network host is attached. It never sends it over TCP or in a reply on the network.
- The app reads it only over USB, and only when both lengths are in range and fill the value exactly. Both strings are decoded as UTF-8, with U+FFFD for invalid bytes and nothing removed, so a copied passphrase is the one the board uses.
- The app shows both in the WiFi connect help, the passphrase hidden until the user asks, with a Copy button. It never writes them to the Terminal, a log or a file.

### 0x30 META_THERMAL_FRAME

```
+0  u16  width
+2  u16  height
+4  u8   format     0 = RAW16, the only format accepted
+5  u8   flags      bit 0: radiometric, pixels in centikelvin
+6  u16  reserved   write 0
+8  u16  pixel[width * height]   row-major, y * width + x
```

- Length exactly 8 is an announce, meaning "thermal is coming". The app holds the view slot for thermal instead of showing the camera.
- A full frame must have a length of exactly `8 + 2 * width * height`, so `width * height` can be at most 32763. Any other length is ignored.
- Radiometric pixels convert as `degC = pixel / 100 - 273.15`. Non-radiometric pixels are raw AGC counts. Either kind is normalised per frame for display.

### 0x40 META_VD66_ISP_ENABLED

`u8` mode: 0 off, 1 manual (the ISP panel is live and sends ISP0), 2 auto (on-device white balance, and the panel only shows a notice). Send it about once a second on a camera-less frame. The app resets it to 0 on disconnect.

### 0x50 META_AUDIO_PCM

```
+0  u32  sample_rate    Hz
+4  u8   channels       1 = mono, 2 = interleaved stereo
+5  u8   bits           16 (not read)
+6  u16  sample_count   (not read)
+8  i16  pcm[]          to the end of the record
```

The length must be at least 8. The app takes the PCM length from the record length and ignores `bits` and `sample_count`. It treats a channel count above 2 as 2. The main process reads this record from every frame before any JPEG check or coalescing, so audio is never dropped. Only the first 0x50 in a frame is used, and it holds at most 65527 bytes of PCM. Audio plays only while the user has listening on.

### 0x51 META_AUDIO_CLASS

```
+0  u8   count
+1  u8   top               index of the winning class; 0xFF = nothing cleared the threshold
+2  u16  level             peak |sample|, 0 to 32767
+4  u16  threshold_x1000
+6  u16  score_x1000[count]
```

The length must be at least `6 + 2 * count`. A record with `top` = 0xFF is still a result: it returns the panel to idle.

### 0x52 META_AUDIO_MEL

```
+0  u8  n_mel
+1  u8  n_frames
+2  u8  layout     0 = frame-major (index frame * n_mel + mel), 1 = mel-major (index mel * n_frames + frame)
+3  u8  reserved
+4  u8  data[n_mel * n_frames]   the model input buffer, as-is
```

`n_mel` and `n_frames` must be non-zero. This record is only for diagnostics.

### 0x53 META_AUDIO_LABELS

`u8 count`, then `count` entries of `u8 len` followed by `len` bytes of name. `count` must be non-zero and every entry must be present, or the record is ignored. Send it about once a second. The Audio panel appears when either 0x51 or 0x53 arrives.

### 0x54 META_IMAGE_CLASS

```
+0  u8   count             entries below, 0 to 8, best first; 0 = nothing cleared the threshold
+1  u8   reserved          0
+2  u16  num_classes       the size of the model's label set
+4  u16  threshold_x1000
then count entries:
  +0  u16  class_index
  +2  u16  score_x1000     0 to 1000
  +4  u8   name_len        0 to 48
  +5       name_len bytes of name, no terminator
```

A record that is truncated, or breaks a limit above, is ignored, and the previous result stays on screen. Bytes after the last entry are ignored. A `count` of 0 is still a result: it returns the panel to idle. The names travel inline, so the Image Classifier panel appears with the first result, and an empty name shows as the class index.

### 0x60 META_VISION_ID

`u8` bitmask: bit 0 QR, bit 1 barcode, bit 2 blob, bit 3 AprilTag. 0 means no CV sketch is running. A non-zero value enables the Vision panel. The panel title names the kind only when exactly one bit is set. Send it about every 2 s on video frames.

### Vision result records (0x61, 0x62, 0x63, 0x66)

Each of these starts with `u8 count`. Every result starts with a box and ends with a crop:

```
box:   u16 cx, u16 cy, u16 w, u16 h      normalised to the full frame
crop:  u8 crop_w, u8 crop_h, then crop_w * crop_h u16 RGB565 pixels, row-major
       RGB565 = R in bits 15 to 11, G in bits 10 to 5, B in bits 4 to 0
       crop_w = crop_h = 0 means no crop
```

Current boards send the 0,0 crop sentinel and deliver pictures through 0x70. A `count` of 0 is a valid result and clears the panel. Any truncated result drops the whole record, and the previous result stays on screen.

```
0x61 META_QR_FRAME, per result:
  +0   box (8 bytes)
  +8   u8   version    QR symbol version
  +9   u8   ecc        low 2 bits: 0 M, 1 L, 2 H, 3 Q
  +10  u16  text_len
  +12  text_len bytes of payload, then crop

0x62 META_BARCODE_FRAME, per result:
  +0   box
  +8   u8   symbology  0 unknown, 1 EAN-13, 2 UPC-A, 3 EAN-8
  +9   u16  text_len
  +11  text_len bytes of digits, then crop

0x63 META_BLOB_FRAME, count 0 or 1, per result:
  +0   box
  +8   u16  area       fraction of the analysis window, 65535 = 100 %
  +10  u16  hue        degrees, 0 to 359
  +12  u16  pixels     cluster size in pixels (clamped on the device)
  +14  crop

0x66 META_APRILTAG, per tag (29 bytes, then crop):
  +0   box
  +8   u16  id
  +10  u8   family     0 = tag36h11
  +11  u8   hamming    bits corrected, 0 = clean read
  +12  u16  margin     normalised, 0 to 65535
  +14  i16  angle      rotation in the image, centi-degrees, CCW positive
  +16  u8   pose_valid 0 until the board has a stored calibration
  +17  i16  tx, +19 i16 ty, +21 i16 tz     millimetres
  +23  i16  rx, +25 i16 ry, +27 i16 rz     Euler XYZ, centi-degrees
  +29  crop
```

The pose bytes are always present. When `pose_valid` is 0 the app ignores them and still lists the tag.

### 0x64 META_CAM_CAPS

`u8` bitmask of the manual capture controls the active sensor has: bit 0 exposure, bit 1 gain, bit 2 white balance, bit 3 autofocus. A non-zero value enables the Camera panel. Send it about once a second on a camera-less frame, and only when it is non-zero.

### 0x65 META_TUNE_DESC

```
+0  u8  count, then per parameter:
  +0  u8   id
  +1  u8   type       0 int, 1 float, 2 bool
  +2  u8   hint       0 none, 1 hue (degrees); an unknown hint gives a plain slider
  +3  u8   name_len
  +4       name_len bytes of name
  then i32 lo, i32 hi, i32 current
```

The values are in wire units: raw for int and bool, value x 1000 for float. A truncated descriptor is dropped whole. Send it about once a second on a camera-less frame. The app rebuilds the panel only when the set of (id, name, type, lo, hi) changes, and it uses `current` only to seed a parameter it has not seen before. The device truncates names to 15 characters.

### 0x67 META_EVENT

The record is 17 bytes. Shorter records are ignored. Bytes after the 17th are ignored and kept free for later use.

```
+0   u32  id           monotonic per boot; 0 = none (ignored)
+4   u32  t_ms         device clock, ms since boot
+8   u8   sources      bit 0 motion, 1 NN, 2 audio, 3 thermal, 4 ToF, 5 GPIO, 6 timer, 7 host
+9   u8   state        0 idle, 1 post-roll, 2 writing, 3 refractory
+10  u16  score        sketch-defined
+12  u16  pre_frames   clip frames before t
+14  u16  post_frames  clip frames after t
+16  u8   sinks_ok     bit i = sink i completed the clip
```

A frame may carry several events. Re-announce each one at about 1 Hz for a few seconds as its state advances. The app keeps one entry per id (the latest record wins) and remembers the newest 20.

### 0x70 META_EVIDENCE_CROP

```
+0  u8  count, then per crop:
  +0  u8   result_index   index into the results of the 0x61 to 0x66 record
  +1  u8   w
  +2  u8   h
  +3  u16  rgb565[w * h]
```

- Put 0x70 after its result record in the same frame. With no result record earlier in the frame, the crops merge into the results already on screen. A 0x70 that comes before a result record in the same frame is discarded.
- An out-of-range index is ignored. A zero-size or truncated crop drops the whole record.
- A 64x64 crop takes 3 + 8192 bytes, so one record holds at most 7 of them.
- The board sends 0x70 only while a host holds a SUB0 subscription with bit 0 set.

### 0x71 META_DEBUG_LOG

The Terminal lines the board published in the last ~2 s, numbered. Every frame repeats them, so a burst of lines between two frames, or the same line twice, arrives whole.

```
+0  u32  first   number of the first line; lines start at 1 each boot
+4  u8   count
then count lines:
  +0  u8   len
  +1       len bytes of text
then:
    u8   boot    fixed for one boot of the board
```

- The app prints each number once, as a whole line decoded as for 0x17. An empty line prints as a blank one.
- With `count` 0, `first` is the number the next line will get, so lines that aged out unseen still count.
- Numbers that never arrived show as "[host] N Terminal lines lost".
- A changed `boot` means the board restarted, and printing starts afresh from the new numbers, even when they run past the old ones. The board picks a value that differs from the previous boot's except with odds of 1 in 256.
- Older firmware ends the record after the lines, with no `boot`. The app reads the byte after a complete set of lines as `boot`, and none from a record cut short. Without `boot`, numbers going backwards are the sign of a restart.
- A board that sends 0x71 also sends its latest line as 0x17, which the app then ignores.

## 5. Host-to-device packets

These are raw packets. They have no vendor header and no TLV wrapping. Each one starts with a 4-byte ASCII magic, read as a `u32` LE, and has a fixed length.

- USB: each packet goes out as one bulk OUT transfer on endpoint 0x01, with a 500 ms timeout. Every packet is at most 64 bytes, and the app never puts two packets in one transfer; a board may drop anything after the first.
- TCP: each packet goes behind a vendor frame header (section 2) with `frame_id` 0, `meta_len` 0, `payload_len` the packet's length and `flags` 0. The stream has no other boundaries, so the header is how the board finds where a packet ends. The board closes the connection on any other magic, a non-zero `meta_len` or a `payload_len` over 64. Over TCP the board applies ISP0, CAM0, TUN0 and SUB0, and takes KEY0 as the link-key answer (section 1); ASR0, AST1 and AST2 need the USB cable.
- Delivery is best-effort. The app drops packets while disconnected and expects no reply. The board reports its state through its announces.

| Magic | u32 value | Bytes on the wire | Length | Purpose |
| --- | --- | --- | --- | --- |
| ISP0 | 0x30505349 | 49 53 50 30 | 32 | ISP tuning |
| CAM0 | 0x304D4143 | 43 41 4D 30 | 12 | Camera capture controls |
| TUN0 | 0x304E5554 | 54 55 4E 30 | 10 | Live-tuning value |
| SUB0 | 0x30425553 | 53 55 42 30 | 8 | Evidence subscription |
| KEY0 | 0x3059454B | 4B 45 59 30 | 36 | Link-key answer, TCP only (section 1) |
| ASR0 | 0x30525341 | 41 53 52 30 | 16 | Begin a record transfer, USB only |
| AST1 | 0x31545341 | 41 53 54 31 | 7 + chunk | One chunk of it, USB only |
| AST2 | 0x32545341 | 41 53 54 32 | 4 | Commit it, USB only |

The app sends no ToF configuration: a sketch sets the ToF sensor's profile, ROI and timing itself.

### ISP0: ISP tuning

```
+0   u32  magic
+4   u8   r_shift,  +5 u8 r_mult
+6   u8   g_shift,  +7 u8 g_mult
+8   u8   b_shift,  +9 u8 b_mult
+10  u8   black_level   0 to 255
+11  u8   sharpness     0 to 7
+12  u8   gamma         1 on, 0 off
+13  u8   reserved      0
+14  i16  ccm[9]        colour correction matrix, 256 = 1.0
```

Each white-balance gain is encoded as `v = max(1, floor(gain * 128))`. `shift` is the smallest value from 0 to 7 with `(v >> shift) <= 255`, and `mult = min(255, v >> shift)`. So the encoded gain is about `mult * 2^shift / 128`, with 128 = 1.0x. The CCM is sent in row-major order: the rows of each bundled preset sum to about 256. The app sends ISP0 on Apply, and only when 0x40 reported mode 1.

### CAM0: camera capture controls

```
+0   u32  magic
+4   u8   flags        bit 0 auto exposure, bit 1 auto gain, bit 2 auto white balance
+5   u32  exposure_us  (unaligned)
+9   u16  gain_x256    the app always sends 256
+11  u8   apply_mask   bit 0 auto-exposure flag, bit 1 auto-gain flag,
                       bit 2 auto-white-balance flag, bit 3 exposure_us
```

Only the fields whose apply bit is set carry meaning. The app sends CAM0 in four cases:

- The user toggles auto exposure. Bit 0 is set, plus bit 1 if 0x64 reported gain. Both flag bits carry the same value.
- The user toggles white balance. Bit 2 is set.
- The user releases the exposure slider (100 to 33000 us, with auto exposure off). Bit 3 is set.
- After a connect, on the first 0x64 that reports any capability, unprompted. The board cannot report its CAM0 state, so the app restores the panel's: every control the user left off auto, and that the 0x64 reports, gets its bit (0 and 1 for exposure and gain, 2 for white balance, 3 for an applied exposure value), so one packet can carry several. Nothing is sent when every control is on auto.

No apply bit covers `gain_x256`, so the app never asks the board to apply a gain value. The panel notes that the device clamps exposure to the frame period.

### TUN0: live-tuning value

```
+0  u32  magic
+4  u8   id      parameter id from 0x65
+5  u8   type    parameter type from 0x65
+6  i32  value   wire units (float x 1000), unaligned
```

The app sends TUN0 when the user commits a change. The device clamps the value to the parameter's `lo` to `hi` range.

### SUB0: evidence subscription

```
+0  u32  magic
+4  u32  mask    bit 0 = evidence crops (0x70)
```

SUB0 is a lease. The board lets it lapse 3 s after the last SUB0. The app sends SUB0 when a Vision panel opens, then every 1000 ms while any Vision panel is open, and sends mask 0 when the last one closes. It sends nothing while disconnected. Each packet carries the full current mask, and mask 0 stops the work at once.

### Stored WiFi settings: ASR0, AST1, AST2

The WiFi settings dialog stores the network a board joins or hosts as a record in the board's asset store, over USB only: the board ignores these packets from a network host, so only somebody with the cable can change them. The app sends the packets one every 20 ms.

```
ASR0 (16 bytes):   +0 u32 magic, +4 u32 total_len, +8 u32 crc32 of the whole record,
                   +12 u8 type (2 = WiFi settings), +13 u8[3] reserved, 0
AST1 (7 + chunk):  +0 u32 magic, +4 u16 offset, +6 u8 len (at most 48), then len bytes
AST2 (4 bytes):    +0 u32 magic
```

AST1 chunks carry explicit offsets, so a lost one fails the CRC at commit rather than shifting the rest. The CRC is zlib's (section 6). AST2 checks it and commits, and the board then restarts so its bootloader can write the record. A `total_len` of 0 removes the record. A board whose sketch does not use the WiFi library does not restart and keeps nothing.

The record is TLV with a one-byte length, `u8 tag, u8 len, value`, read by the sketch's `WiFi.begin()` with no arguments:

| Tag | Value | The app sends it |
| --- | --- | --- |
| 1 | `u8` mode: 1 join a network, 2 host one | always |
| 2 | network name, 1 to 32 bytes | always |
| 3 | password, 8 to 63 printable ASCII characters, or 64 hex digits with WPA2 | always when joining; when hosting, unless the board is to use its own password |
| 4 | `u8` security: 3 WPA2, 5 WPA3, 6 WPA2/WPA3 | always |
| 5 | `u8` channel, 1 to 11 | when hosting; the board defaults to 6 |
| 6 | hostname, letters, digits and hyphens, up to 32 | when given |
| 7 | link key, 8 to 64 bytes (section 1) | when given |

From core 0.1.3 the board refuses a record with any other security value, such as 0 for an open network, and one that joins a network with no password. It checks only a password's length, so the app checks the rest before sending, since the board's refusal shows only on its serial console. Without tag 3 a hosted network uses the board's own password, which the board sends over USB in 0x24 (section 4).

The core's `n6bench.py wifiset` writes the same bytes.

## 6. Bootloader (DFU) protocol

The FSBL speaks DFU over a USB CDC ACM serial port, a separate function from the vendor interface 0. On Windows the application's CDC port is interface 1 (`MI_01`). The app opens the port at 115200 baud, 8N1, with no flow control, and asserts DTR and RTS.

| VID:PID | Role |
| --- | --- |
| 0x1209:0x8008 | Application (its CDC console) |
| 0x1209:0x8009 | FSBL bootloader |
| 0xCAFE:0x4013 | FSBL bootloader, and application firmware before 0x1209:0x8008 |
| 0xCAFE:0x4014 | Older bootloader firmware |

Any port with VID 0xCAFE counts as a bootloader candidate. If the user picks a port with unknown IDs by hand, the app probes it with DFU_INFO.

### Entering the bootloader

1. If the user picked a port by hand, only that port is used. Otherwise, if a port with a bootloader identity is already present, the app uses it.
2. If an application port is present, the app does the 1200-baud touch: it opens the port at 1200 baud with DTR and RTS on, waits 100 ms, drops DTR (RTS stays on), waits 50 ms and closes. Core sketches and BSP applications restart into the FSBL on it. The app waits up to 6 s for a bootloader port.
3. If the application port is still there after that, the app opens it at 115200 baud, asserts DTR and RTS, waits 100 ms, flushes, sends `b\n` (62 0A), waits 300 ms and closes the port. An application that ignores the touch should jump to the FSBL when it gets `b`. The app then waits up to 12 s. The touch comes first because a core sketch with its debug console off passes `b` to the sketch as Serial input.
4. If the port cannot be opened, the app says another program may be using it and waits up to 12 s for a bootloader port.
5. If no application port is present, the app waits up to 12 s for a bootloader to appear and asks the user to double-tap reset.

### Framing

```
0x02 | u16 LE payload length | payload | u8 XOR of the payload bytes | 0x03
```

The checksum covers the payload only, and is 0 for an empty payload. A payload can be at most 65535 bytes. For example, DFU_INFO is `02 08 00 44 46 55 5F 49 4E 46 4F 06 03`.

### Commands

A command payload is ASCII text, followed directly by any `u32` LE arguments with no separator. Addresses are offsets from 0x90000000.

| Payload | Arguments | Reply on success | Error lines |
| --- | --- | --- | --- |
| `DFU_INFO` | none | optional `N6INFO ...` line, then `N6ACK` | |
| `DFU START` (with a space) | u32 offset | `N6ACK` | `START_BAD_ADDR` |
| `DFU_ERASE` | u32 size | `N6ACK` | `ERASE_BAD_SIZE` |
| `DFU_DATA` | none | `N6ACK`, then the data phase begins | |
| data chunk | up to 4096 raw image bytes | `N6ACK`, plus an extra `N6ACK` every 16 KiB | |
| `DFU_NEXT` | none | `NEXT_OK` line, then `N6ACK` | |
| `DFU_END` | none | the device resets; it may print `DFU_DONE` first | |
| `DFU_CRC32` | u32 offset, u32 length | `CRC32 0x<hex>` line, then `N6ACK` | |
| `DFU_RESET` | none | the device resets (valid only after `DFU_NEXT`) | |

Replies are ASCII lines ending in LF. The host trims whitespace, including CR, from each line. After each command the host reads lines until `N6ACK`. Lines before it are informational, and a listed error line aborts the flash. The time allowed covers a command's whole reply up to its `N6ACK`, not each line: 30 s for `DFU START`, `DFU_DATA` and `DFU_NEXT`, 3 s for DFU_INFO, 60 s plus 2 s per 64 KiB erased for DFU_ERASE, and 30 s plus 1 s per MiB for DFU_CRC32. Each data chunk's `N6ACK` has its own 30 s. After DFU_END and DFU_RESET, which reset the device, the host reads at most one line, for 5 s and 3 s.

`N6INFO` grammar: `N6INFO <version> <token> ... [UID <serial>]`. `UID` takes the next token as the serial. Every other token is a capability:

- `CRC32` enables `DFU_CRC32`.
- `MULTI` enables `DFU_NEXT`, several images in one session, and verify-before-reset.
- `OTA-AB` is parsed but not used by the flash job.

The version defaults to 1 if it is missing: when the token after `N6INFO` is not a number, it is read as a capability. A v1 FSBL that answers DFU_INFO with only `N6ACK` counts as a bootloader with no capabilities.

Data phase: every chunk is a normal frame whose payload is raw image bytes. The host counts bytes since the last extra ack. When a chunk brings that count to 16384 or more, the host reads a second `N6ACK` and resets the count to 0. With 4096-byte chunks, that happens after every fourth chunk. A short final chunk adds only its own length.

CRC: CRC-32 as in zlib (reflected polynomial 0xEDB88320, initial value 0xFFFFFFFF, final XOR 0xFFFFFFFF). `"123456789"` gives 0xCBF43926. The host accepts the hex value in the reply with a `0x` or `0X` prefix, or none.

### Flash sequence the app runs

1. Check every image: it must be non-empty, and 0x90000000 + offset + length - 1 must not be past 0x91FFFFFF.
2. Suspend all video sessions, enter the bootloader and open the port.
3. Send `DFU_INFO`. Without `MULTI`, only one image is allowed.
4. For each image, send `DFU START` offset, then `DFU_ERASE` with the length rounded up to a multiple of 4096, then `DFU_DATA`, then the chunks with their acks.
5. With `MULTI`: send `DFU_NEXT` (a `NEXT_OK` line is required), then `DFU_CRC32` offset length, and compare the result with the host CRC. On a mismatch, repeat step 4 once. A second mismatch, or no CRC reply from a bootloader that claims `CRC32`, fails the flash and leaves the board in the bootloader. Without the `CRC32` capability the check is skipped.
6. Without `MULTI`: send `DFU_END`. The device resets at once and nothing is verified.
7. With `MULTI`, after the last image: send `DFU_RESET`.
8. Wait up to 10 s for the board's application port to come back (only a port that was not present during the flash counts), then resume the video sessions.

If a flash fails and the board is still in its FSBL, the video sessions stay parked until it resets or is unplugged. The user can cancel a flash before writing starts, and after that only once it has stalled.

### Flash map

| Item | Value |
| --- | --- |
| Base | 0x90000000 |
| Last byte | 0x91FFFFFF (32 MiB) |
| Sector (erase granularity) | 0x1000 (4 KiB) |
| Data chunk | 4096 bytes |

| Target in the app | Offset | Address |
| --- | --- | --- |
| Bootloader (FSBL) | 0x00000000 | 0x90000000 |
| Application | 0x00100000 | 0x90100000 |
| Application slot B | 0x01C80000 | 0x91C80000 |
| Custom | any offset in range | |

Custom addresses are typed in hex with a `0x` prefix, as an absolute address or an offset, on a 4 KiB boundary. Anything inside the first 1 MiB (the FSBL region) needs the same confirmation as the FSBL target. An interrupted FSBL write is recoverable only with BOOT1 and SWD.
