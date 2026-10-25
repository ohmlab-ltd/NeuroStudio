# Third-Party Notices

Neuro Studio is Copyright (C) 2026 Ohm Lab Ltd and is released under the GNU
General Public License v3.0 only (see `LICENSE`). The packaged application
distributes the third-party components below. Each component remains under its
own licence; the full texts are reproduced or referenced at the end of this
file, and every npm package's own `LICENSE` file is also included inside the
packaged application alongside its code.

## 1. npm runtime packages

All of the following are distributed with the packaged application (inside
`app.asar`; `usb` and `@serialport/*` are unpacked next to it). Versions are
the exact versions pinned by `package-lock.json`; direct dependencies are
declared as `react ^19.2.8`, `react-dom ^19.2.8`, `serialport ^13.0.0`,
`usb ^2.16.0`.

| Package | Version(s) | Licence | Copyright |
| --- | --- | --- | --- |
| react | 19.2.8 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| react-dom | 19.2.8 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| scheduler | 0.27.0 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| serialport | 13.0.0 | MIT | Copyright 2010 Christopher Williams. All rights reserved. |
| @serialport/bindings-cpp | 13.0.0 | MIT | Copyright 2010 Christopher Williams. All rights reserved. |
| @serialport/stream | 13.0.0 | MIT | Copyright 2010 Christopher Williams. All rights reserved. |
| @serialport/parser-byte-length | 13.0.0 | MIT | Copyright 2010 Christopher Williams. All rights reserved. |
| @serialport/parser-cctalk | 13.0.0 | MIT | Copyright 2010 Christopher Williams. All rights reserved. |
| @serialport/parser-delimiter | 13.0.0, 12.0.0 | MIT | Copyright 2010 Christopher Williams. All rights reserved. |
| @serialport/parser-inter-byte-timeout | 13.0.0 | MIT | Copyright 2010 Christopher Williams. All rights reserved. |
| @serialport/parser-packet-length | 13.0.0 | MIT | Copyright 2010 Christopher Williams. All rights reserved. |
| @serialport/parser-readline | 13.0.0, 12.0.0 | MIT | Copyright 2010 Christopher Williams. All rights reserved. |
| @serialport/parser-ready | 13.0.0 | MIT | Copyright 2010 Christopher Williams. All rights reserved. |
| @serialport/parser-regex | 13.0.0 | MIT | Copyright 2010 Christopher Williams. All rights reserved. |
| @serialport/parser-slip-encoder | 13.0.0 | MIT | Copyright 2010 Christopher Williams. All rights reserved. |
| @serialport/parser-spacepacket | 13.0.0 | MIT | Copyright 2010 Christopher Williams. All rights reserved. |
| @serialport/binding-mock | 10.2.2 | MIT | Copyright (c) 2021 Francis Gulotta |
| @serialport/bindings-interface | 1.2.2 | MIT | Copyright (c) 2021 Francis Gulotta |
| usb (node-usb) | 2.18.0 | MIT (bundles libusb, see section 2) | Copyright (c) 2012 Nonolith Labs, LLC |
| @types/w3c-web-usb | 1.0.14 | MIT | Copyright (c) Microsoft Corporation. |
| debug | 4.4.3, 4.4.0 | MIT | Copyright (c) 2014-2017 TJ Holowaychuk \<tj@vision-media.ca\>; Copyright (c) 2018-2021 Josh Junon |
| ms | 2.1.3 | MIT | Copyright (c) 2020 Vercel, Inc. |
| node-addon-api | 8.9.2, 8.3.0 | MIT | Copyright (c) 2017 Node.js API collaborators |
| node-gyp-build | 4.8.4 | MIT | Copyright (c) 2017 Mathias Buus |

## 2. libusb (statically linked into the `usb` native module)

The prebuilt native binaries of the `usb` package (node-usb) statically link
**libusb**, Copyright (c) 2001-present the libusb authors (Johannes Erdfelt,
Daniel Drake, Pete Batard, Nathan Hjelm, Chris Dickens, and others; see the
`AUTHORS` file in the libusb source).

libusb is licensed under the **GNU Lesser General Public License, version 2.1
or later (LGPL-2.1-or-later)**. The full licence text is distributed with the
application at `node_modules/usb/libusb/COPYING` (unpacked from the asar
archive), and the complete corresponding source of the bundled libusb is
included in the published `usb` npm package (`node_modules/usb/libusb/`) and at
<https://github.com/libusb/libusb>. The LGPL-2.1 is compatible with this
application's GPL-3.0-only licence; the complete source code of Neuro Studio,
including its build scripts, is published at the project repository.

## 3. Fonts

The following fonts are bundled with the application (in `dist/fonts/`, built
from `public/fonts/`), under the **SIL Open Font License, Version 1.1** (OFL-1.1).
The full licence texts, including the reserved font name statements, are
distributed with the application next to the font files:

- **Inter** (Regular, Medium, SemiBold, Bold):
  Copyright (c) 2016 The Inter Project Authors (<https://github.com/rsms/inter>).
  Licence text: `fonts/Inter-LICENSE-OFL.txt`.
- **JetBrains Mono** (Regular):
  Copyright 2020 The JetBrains Mono Project Authors
  (<https://github.com/JetBrains/JetBrainsMono>).
  Licence text: `fonts/JetBrainsMono-LICENSE-OFL.txt`.

The fonts are distributed as separate, unmodified font files alongside the
program and remain under the OFL; they are not part of the GPL-licensed
program code.

## 4. Electron runtime

Packaged builds of Neuro Studio ship the **Electron** framework (v43.x),
Copyright (c) Electron contributors and Copyright (c) 2013-2020 GitHub Inc.,
licensed under the MIT licence. Electron in turn bundles Chromium, Node.js,
V8 and other components under their own licences. The packaged application
includes Electron's licence as `LICENSE.electron.txt` and the aggregated
Chromium third-party licences as `LICENSES.chromium.html` in its resources
directory (placed there automatically by electron-builder).

## 5. Licence texts

### MIT License

The following text applies to every package listed in section 1, with the
copyright line given for that package in the table above:

```
MIT License

Copyright (c) <copyright holders as listed above>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### GNU Lesser General Public License v2.1 (libusb)

The full text is distributed at `node_modules/usb/libusb/COPYING` in the
packaged application and is available at
<https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html>.

### SIL Open Font License 1.1 (Inter, JetBrains Mono)

The full texts are distributed at `fonts/Inter-LICENSE-OFL.txt` and
`fonts/JetBrainsMono-LICENSE-OFL.txt` in the packaged application (and at
`public/fonts/` in the source tree) and are available at
<https://scripts.sil.org/OFL>.
