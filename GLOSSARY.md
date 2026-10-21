# Chromecraft

Chromecraft is a privacy-first, Minecraft-palette desktop browser. Its first release targets dependable daily browsing on Windows.

## Language

**Browser Shell**:
The Chromecraft-owned desktop experience surrounding web pages, including navigation, tabs, the sidebar, and browser settings.
_Avoid_: Chrome, UI chrome

**Core Browsing Foundation**:
The first implementation milestone: a reliable, local-first browser shell that can navigate ordinary web pages and manage horizontal tabs.
_Avoid_: Prototype, theme demo

**Daily Driver Fundamentals**:
The follow-on browser capabilities that make sustained everyday use practical, such as downloads, history, session recovery, site controls, and the Sidebar.
_Avoid_: Feature-complete browser

**Default Profile**:
The single local browsing identity available in the first release, containing the user's ordinary browsing state.
_Avoid_: Account, Chromecraft account

**Private Window**:
A temporary browsing space whose state is discarded when it is closed.
_Avoid_: Incognito profile

**Privacy Center**:
The user-facing place that explains and controls browser-initiated network-affecting features and per-site privacy choices.
_Avoid_: Metrics panel, tracking settings

**Site Network Control**:
A Privacy Center rule governing the network access available to a website or one of its embedded third parties.
_Avoid_: Private DNS, website firewall

**Third Party**:
An internet service embedded or requested by a website whose origin differs from the website the user deliberately opened.
_Avoid_: Website, tracker

**Sidebar**:
The vertical Browser Shell rail for browser destinations and later opt-in workspace modules; it is separate from the horizontal tab bar.
_Avoid_: Vertical tab bar

**Workspace Module**:
An optional sidebar capability, such as a music player or messaging service, that is not part of the core browsing surface.
_Avoid_: Built-in app

**Chrome Web Store Listing**:
An eligible detail page on the exact Chrome Web Store origin whose item identifier names the extension being considered.
_Avoid_: Store page, extension website

**Extension Install Banner**:
The contextual Browser Shell surface that presents installation status and actions while a Chrome Web Store Listing is active.
_Avoid_: Injected banner, page banner, install bar

**Extension Install Preview**:
Verified package identity, capabilities, and compatibility information presented before an extension is installed into the Default Profile.
_Avoid_: Web Store preview, install popup
