# Zonecheck

<img width="1600" height="1000" alt="Zonecheck" src="https://github.com/user-attachments/assets/1c78e404-60c7-4c7d-a180-ddd738a53292" />

Zonecheck is an AI-powered Chrome extension that helps users understand time zones, compare availability, and generate scheduling replies directly inside Gmail.

Now available on the Chrome Web Store:  
https://chromewebstore.google.com/detail/iadkodaihejbcbpkihodonkhmkmmdjjg

---

## Features

- Detect scheduling-related times inside Gmail emails
- Compare time zones instantly
- Visualize shared scheduling windows
- Avoid suggesting times outside working hours
- Generate AI-assisted scheduling replies
- Copy suggested replies directly into Gmail
- Designed directly inside the Gmail workflow

---

## Screenshots

### Timezone comparison
<img width="1280" height="800" alt="Screenshot_1" src="https://github.com/user-attachments/assets/d6017ceb-e92d-45a9-b810-b1a640c03e00" />

### Scheduling detection
<img width="1280" height="800" alt="Screenshot_2" src="https://github.com/user-attachments/assets/a0b5d9d9-de91-43a0-a80e-fa37557e158e" />

### Shared availability
<img width="1280" height="800" alt="Screenshot_3" src="https://github.com/user-attachments/assets/02114455-9197-4a29-8cea-2e0e7cf49b1e" />

### AI-generated replies
<img width="1280" height="800" alt="Screenshot_4" src="https://github.com/user-attachments/assets/5e519eeb-3d06-402f-8717-ea77eb3dd36d" />

---

## Tech Stack

- JavaScript
- Chrome Extension Manifest V3
- Anthropic Claude API
- Gmail Content Scripts

---

## Demo

Chrome Web Store:
https://chromewebstore.google.com/detail/iadkodaihejbcbpkihodonkhmkmmdjjg?utm_source=item-share-cb

Demo video:
https://youtu.be/cMa8GlSuhEY

---

## Local Development

```bash
git clone https://github.com/jessicahsu20001106/zonecheck.git

cd zonecheck

npm install
```

Load the extension in Chrome:

```text
chrome://extensions
```

- Enable Developer Mode
- Click "Load unpacked"
- Select the project folder

---

## Permissions

Zonecheck uses the following permissions:

- `storage`
- `clipboardWrite`

Host permissions:
- `https://mail.google.com/*`
- `https://zonecheck-api.vercel.app/*`

---

## Privacy

Zonecheck processes scheduling-related email content only to provide timezone comparison and scheduling assistance.

The extension does not:
- sell user data
- use data for advertising
- permanently store personal email content externally

Privacy Policy:
https://jessicahsu.design/privacy-policy

---

## Status

Published on the Chrome Web Store

---

## License

MIT
