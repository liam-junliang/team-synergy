"""Fingerprint a fixed source tree or check a reverse-engineering dossier."""
import argparse
from collections import Counter
from fnmatch import fnmatchcase
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys


SKIP = {".git", ".codegraph", ".ua", ".understand-anything", "__pycache__", "node_modules"}
CITATION = re.compile(r"`([\w./@+\-]+):(\d+)(?:-(\d+))?`")


def require(ok, message):
    if not ok:
        raise ValueError(message)


def confined(root, relative):
    p = PurePosixPath(relative)
    require(relative and not p.is_absolute() and not set(p.parts) & {".", ".."}
            and "\\" not in relative and ":" not in relative, f"invalid path: {relative}")
    f = root.joinpath(*p.parts)
    require(f.resolve().is_relative_to(root) and f.is_file(), f"missing/outside: {relative}")
    return f


def content(f):
    return f.read_text(encoding="utf-8-sig")


def digest(f):
    h = hashlib.sha256()
    with f.open("rb") as data:
        for block in iter(lambda: data.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def manifest(root, output):
    require(root.is_dir() and not output.resolve().is_relative_to(root), "place the manifest outside the fixed source directory")
    files = []
    for directory, dirs, names in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d not in SKIP and not (Path(directory) / d).is_symlink())
        for name in sorted(names):
            file = Path(directory) / name
            if not file.is_symlink() and file.is_file():
                relative = file.relative_to(root).as_posix()
                files.append({"path": relative, "sha256": digest(confined(root, relative))})
    require(files, "empty source")
    with output.open("x", encoding="utf-8") as out:
        json.dump({"files": sorted(files, key=lambda row: row["path"])}, out, ensure_ascii=False, indent=2)


class Screen(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = Counter()

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name == "id":
                self.ids[value] += 1


def has_id(text, identifier):
    return re.search(r"(?<![\w-])" + re.escape(identifier) + r"(?![A-Za-z0-9_-])", text, re.ASCII) is not None


def check(source, source_manifest, book):
    spec = json.loads(content(confined(book, "coverage.json")))
    rows = json.loads(content(source_manifest))["files"]
    files = {row["path"]: row["sha256"] for row in rows}
    require(files and len(files) == len(rows), "empty or duplicate source manifest")
    for name, expected in files.items():
        require(digest(confined(source, name)) == expected, f"source drift: {name}")

    module_ids, features, documents, line_counts = set(), set(), set(), {}
    citations = 0

    def audit_doc(name):
        nonlocal citations
        text = content(confined(book, name))
        require(text.strip(), f"empty artifact: {name}")
        if name not in documents:
            for loc, start, end in CITATION.findall(text):
                require(loc in files, f"{name}: unknown source {loc}")
                if loc not in line_counts:
                    line_counts[loc] = len(content(confined(source, loc)).splitlines())
                require(1 <= int(start) <= int(end or start) <= line_counts[loc], f"{name}: bad range {loc}:{start}-{end}")
                citations += 1
            documents.add(name)
        return text

    require(spec["modules"] and spec["artifacts"] and spec["journeys"], "missing modules, supporting deliverables or journeys")
    for module in spec["modules"]:
        mid = module["id"]
        require(mid and mid not in module_ids, f"duplicate/empty module {mid}")
        module_ids.add(mid)
        text = audit_doc(module["document"])
        require(CITATION.search(text) and module["features"], f"missing source/features in {mid}")
        for feature in module["features"]:
            require(feature and feature not in features and has_id(text, feature), f"missing/duplicate feature {feature}")
            features.add(feature)
    for item in spec["artifacts"]:
        audit_doc(item)
    surfaces = set()
    for item in spec["surfaces"]:
        name = item["path"]
        require(name in files and name not in surfaces, f"unknown/duplicate surface {name}")
        owner, reason = item.get("module"), item.get("excluded", "").strip()
        require((owner in module_ids and not reason) or (owner is None and reason), f"invalid disposition {name}")
        surfaces.add(name)
    require(spec["inventoryPatterns"] and surfaces, "empty inventory")
    for pattern in spec["inventoryPatterns"]:
        matches = {f for f in files if fnmatchcase(f, pattern)}
        require(matches, f"inventory pattern has no matches: {pattern}")
        for candidate in source.glob(pattern):
            if candidate.is_file() and not set(candidate.relative_to(source).parts) & SKIP:
                require(candidate.relative_to(source).as_posix() in files, f"unfrozen surface: {candidate.relative_to(source)}")
        require(matches <= surfaces, f"unassigned surfaces: {sorted(matches-surfaces)}")
    seen = set()
    for journey in spec["journeys"]:
        jid, prototype = journey["id"], journey["prototype"]
        require(jid and jid not in seen and journey["features"] and set(journey["features"]) <= features, f"invalid journey {jid}")
        seen.add(jid)
        screen = content(confined(book, prototype))
        require(journey["states"], f"no states in {jid}")
        if prototype.lower().endswith((".html", ".htm")):
            parser = Screen()
            parser.feed(screen)
            require(all(parser.ids[s] == 1 for s in journey["states"]), f"missing/ambiguous HTML state in {jid}")
        else:
            require(all(has_id(screen, s) for s in journey["states"]), f"missing interface state in {jid}")
        require(has_id(audit_doc(journey["acceptance"]), journey["case"]), f"unresolved acceptance case in {jid}")
    return dict(sourceFiles=len(files), surfaces=len(surfaces), modules=len(module_ids), features=len(features),
                journeys=len(seen), citedRanges=citations)


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    actions = cli.add_subparsers(dest="action", required=True)
    for name in ("manifest", "check"):
        parser = actions.add_parser(name)
        parser.add_argument("--source", type=Path, required=True)
        if name == "manifest":
            parser.add_argument("--out", type=Path, required=True)
        else:
            parser.add_argument("--manifest", type=Path, required=True)
            parser.add_argument("--book", type=Path, required=True)
    args = cli.parse_args()
    if args.action == "manifest":
        manifest(args.source.resolve(), args.out)
    else:
        print(json.dumps(check(args.source.resolve(), args.manifest, args.book.resolve())))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError) as error:
        sys.exit(str(error))
