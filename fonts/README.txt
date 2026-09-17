Optional licensed presentation fonts
====================================

Place organization-owned or otherwise redistributable .ttf and .otf files in
this directory before building the Docker image. The Dockerfile copies them
into the runtime fontconfig directory and refreshes the font cache.

Do not commit or redistribute proprietary Microsoft fonts unless your license
explicitly permits it. The runtime already installs open, metric-compatible
families including Carlito (Calibri) and Caladea (Cambria), plus Liberation,
DejaVu, Noto, FreeFont, and URW fonts.
