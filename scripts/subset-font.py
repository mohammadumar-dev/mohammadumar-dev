#!/usr/bin/env python3
"""Cut a Mona Sans variable font down to one static instance of one glyph set.

Panels inline their fonts as data URIs, so size is the whole game. Subsetting
alone is not enough: Mona Sans carries three variable axes (wdth, wght, opsz)
and the gvar deltas survive glyph subsetting — 308 KB becomes 95 KB, which is
still far too heavy to repeat in four images. Pinning every axis afterwards
drops fvar/gvar/avar entirely and lands around 10 KB.

    subset-font.py <src.woff2> <out.woff2> wght=800,wdth=112,opsz=32

Axes the source does not declare are ignored, so the same pin string works for
both the proportional and the monospace face.
"""

import math
import re
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

# Printable ASCII plus the middot, dashes and non-breaking space the panels draw.
UNICODES = "U+0020-007E,U+00A0,U+00B7,U+2013,U+2014"

# An OpenType axis tag is four printable ASCII characters. str.isalnum() is true
# for '١٢٣٤' and other non-ASCII digits, so it does not say what it looks like it
# says; spell the alphabet out.
AXIS_TAG = re.compile(r"\A[A-Za-z0-9]{4}\Z")

# Axis values live in a small, well-known numeric range. float() otherwise
# accepts 'inf' and 'nan', which reach instantiateVariableFont and come back out
# as garbage deltas rather than an error.
AXIS_MIN, AXIS_MAX = -10_000.0, 10_000.0


def parse_pins(pins):
    """wght=800,wdth=112 -> {"wght": 800.0, "wdth": 112.0}, rejecting anything else."""
    wanted = {}
    for pin in filter(None, pins.split(",")):
        tag, sep, raw = pin.partition("=")
        tag = tag.strip()
        if not sep:
            raise ValueError(f"axis {tag!r} has no value")
        if not AXIS_TAG.match(tag):
            raise ValueError(f"not an axis tag: {tag!r}")
        try:
            value = float(raw)
        except ValueError:
            raise ValueError(f"axis {tag} has a non-numeric value: {raw!r}") from None
        if not math.isfinite(value) or not AXIS_MIN <= value <= AXIS_MAX:
            raise ValueError(f"axis {tag} value out of range: {raw!r}")
        wanted[tag] = value
    return wanted


def main(src, out, pins):
    wanted = parse_pins(pins)

    # recalcTimestamp defaults to True, which rewrites head.modified to "now" on
    # every save. That makes the subset — and so the base64 in every panel that
    # embeds it — different on each run even when nothing about the font or the
    # data changed. The nightly job then commits ten identical-looking SVGs, and
    # the README's cache keys churn along with them. Keep the source timestamp.
    font = TTFont(src, recalcTimestamp=False)

    options = subset.Options()
    options.layout_features = ["kern", "liga", "calt"]
    options.name_IDs = ["*"]
    options.drop_tables += ["DSIG"]
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=subset.parse_unicodes(UNICODES))
    subsetter.subset(font)

    if "fvar" in font:
        declared = {axis.axisTag for axis in font["fvar"].axes}
        pinned = {tag: value for tag, value in wanted.items() if tag in declared}
        if pinned:
            font = instancer.instantiateVariableFont(font, pinned, inplace=True)

    font.flavor = "woff2"
    font.save(out)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(f"usage: {sys.argv[0]} <src.woff2> <out.woff2> <axis=value,...>")
    main(sys.argv[1], sys.argv[2], sys.argv[3])
