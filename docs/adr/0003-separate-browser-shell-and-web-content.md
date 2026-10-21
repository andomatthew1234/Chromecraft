# Separate the Browser Shell from web content

Chromecraft will render its React-based Browser Shell as local application content and each remote website as a separately managed Electron web contents view. This is more work than embedding pages in the shell, but it preserves the boundary required for a dependable browser and keeps future workspace modules from receiving website privileges.
