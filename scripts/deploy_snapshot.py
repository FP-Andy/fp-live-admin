"""Back up a checkout and prove it can be restored before deployment resets it.

Only Git-tracked and non-ignored untracked files are copied. Runtime/DB backups
are separate. This tool never resets, cleans, or modifies the source checkout.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tarfile
import tempfile


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args], stderr=subprocess.PIPE)


def digest(path):
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            checksum.update(block)
    return checksum.hexdigest()


def file_state(path):
    if path.is_symlink():
        return {"link": os.readlink(path)}
    if not path.exists():
        return None
    if not path.is_file():
        raise RuntimeError(f"Unsupported checkout entry: {path}")
    return {"sha256": digest(path), "executable": bool(path.stat().st_mode & stat.S_IXUSR)}


def names(raw):
    return [os.fsdecode(part) for part in raw.split(b"\0") if part]


def patch(repo, staged=False):
    return git(repo, "diff", *( ["--cached"] if staged else []),
               "--binary", "--full-index", "--no-ext-diff", "--no-textconv")


def status(repo):
    return git(repo, "status", "--porcelain=v1", "-z", "--untracked-files=all")


def safe_path(root, name):
    relative = Path(name)
    if relative.is_absolute() or ".." in relative.parts or ".git" in relative.parts:
        raise RuntimeError("Unsafe archive entry")
    path = root / relative
    for parent in path.parents:
        if parent == root:
            break
        if parent.is_symlink():
            raise RuntimeError("Archive path traverses a symlink")
    return path


def extract(archive, root):
    # Preserve link text without following links, including links outside the
    # checkout. Git never needs to write through a symlink to restore a file.
    with tarfile.open(archive) as tar:
        for member in tar:
            path = safe_path(root, member.name)
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True)
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.is_symlink() or path.is_file():
                path.unlink()
            if member.issym():
                path.symlink_to(member.linkname)
            elif member.isfile():
                with tar.extractfile(member) as source, path.open("xb") as target:
                    shutil.copyfileobj(source, target)
                path.chmod(member.mode & 0o777)
            else:
                raise RuntimeError("Unsupported archive entry")


def check_ignored_collisions(repo, target):
    tracked = set(names(git(repo, "ls-files", "-z")))
    for name in names(git(repo, "ls-tree", "-r", "--name-only", "-z", target)):
        path = repo / name
        candidates = [path, *[p for p in path.parents if p != repo and repo in p.parents]]
        for candidate in candidates:
            relative = str(candidate.relative_to(repo))
            if relative in tracked or not os.path.lexists(candidate):
                continue
            # A target file must not replace an ignored runtime file/directory,
            # or a parent that is an ignored file/symlink.
            if candidate != path and candidate.is_dir() and not candidate.is_symlink():
                continue
            result = subprocess.run(["git", "-C", str(repo), "check-ignore", "-q", "--", relative])
            if result.returncode == 0:
                raise RuntimeError(f"Target would replace ignored runtime path: {relative}")
            if result.returncode not in (0, 1):
                raise RuntimeError("Could not check ignored runtime paths")


def restore(backup, destination):
    manifest = json.loads((backup / "manifest.json").read_text())
    for name, expected in manifest["archives"].items():
        if digest(backup / name) != expected:
            raise RuntimeError(f"Backup checksum mismatch: {name}")
    if destination.exists() and any(destination.iterdir()):
        raise RuntimeError("Restore destination must be empty")
    destination.mkdir(parents=True, exist_ok=True)
    git(destination, "init", "-q")
    extract(backup / "base.tar", destination)
    git(destination, "add", "-f", "--all")
    git(destination, "-c", "user.name=FPC restore", "-c", "user.email=restore@example.invalid",
        "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-qm", "Restore base")
    if git(destination, "rev-parse", "HEAD^{tree}").decode().strip() != manifest["base_tree"]:
        raise RuntimeError("Restored base tree differs")
    (destination / ".git/info/exclude").write_bytes((backup / "exclude").read_bytes())
    if (backup / "index.patch").stat().st_size:
        git(destination, "apply", "--index", "--binary", str(backup / "index.patch"))
    for name, state in manifest["files"].items():
        path = safe_path(destination, name)
        if state is None and (path.is_symlink() or path.is_file()):
            path.unlink()
    extract(backup / "worktree.tar", destination)
    actual = {name: file_state(safe_path(destination, name)) for name in manifest["files"]}
    if actual != manifest["files"] or patch(destination, True) != (backup / "index.patch").read_bytes():
        raise RuntimeError("Restored bytes or staging differ")
    if status(destination) != (backup / "status.z").read_bytes():
        raise RuntimeError("Restored checkout status differs")
    return manifest


def snapshot(repo, destination, target=None):
    repo, destination = repo.resolve(), destination.resolve()
    if destination == repo or repo in destination.parents:
        raise RuntimeError("Backup must be outside the source checkout")
    if target:
        check_ignored_collisions(repo, target)
    if git(repo, "ls-files", "--unmerged"):
        raise RuntimeError("Resolve index conflicts before deployment")
    destination.mkdir(parents=True, mode=0o700, exist_ok=False)
    before_status, before_index = status(repo), patch(repo, True)
    files = sorted(set(names(git(repo, "ls-tree", "-r", "--name-only", "-z", "HEAD"))
                       + names(git(repo, "ls-files", "-z"))
                       + names(git(repo, "ls-files", "--others", "--exclude-standard", "-z"))))
    states = {name: file_state(repo / name) for name in files}
    (destination / "status.z").write_bytes(before_status)
    (destination / "index.patch").write_bytes(before_index)
    (destination / "worktree.patch").write_bytes(patch(repo))
    exclude = Path(os.fsdecode(git(repo, "rev-parse", "--git-path", "info/exclude")).strip())
    if not exclude.is_absolute():
        exclude = repo / exclude
    (destination / "exclude").write_bytes(exclude.read_bytes() if exclude.exists() else b"")
    with (destination / "base.tar").open("wb") as output:
        subprocess.run(["git", "-C", str(repo), "archive", "--format=tar", "HEAD"], stdout=output, check=True)
    with tarfile.open(destination / "worktree.tar", "w", dereference=False) as archive:
        for name, state in states.items():
            if state is not None:
                archive.add(repo / name, arcname=name, recursive=False)
    if states != {name: file_state(repo / name) for name in files} or before_status != status(repo) or before_index != patch(repo, True):
        raise RuntimeError("Checkout changed while being backed up; retry after writers finish")
    artifacts = ["base.tar", "worktree.tar", "index.patch", "worktree.patch", "status.z", "exclude"]
    manifest = {"version": 1, "head": git(repo, "rev-parse", "HEAD").decode().strip(),
                "base_tree": git(repo, "rev-parse", "HEAD^{tree}").decode().strip(),
                "files": states, "archives": {name: digest(destination / name) for name in artifacts}}
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=True, indent=2) + "\n")
    with tempfile.TemporaryDirectory(prefix="fpc-restore-check-", dir=destination.parent) as temporary:
        restore(destination, Path(temporary))
    if (states != {name: file_state(repo / name) for name in files}
            or before_status != status(repo) or before_index != patch(repo, True)
            or manifest['head'] != git(repo, 'rev-parse', 'HEAD').decode().strip()):
        raise RuntimeError("Checkout changed during restore verification; retry after writers finish")
    if target:
        check_ignored_collisions(repo, target)
    # This marker is written only after a separate checkout reproduces the bytes
    # and index. A failed snapshot never grants permission to reset/clean.
    (destination / "VERIFIED").write_text(digest(destination / "manifest.json") + "\n")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    save = sub.add_parser("snapshot")
    save.add_argument("repo", type=Path)
    save.add_argument("destination", type=Path)
    save.add_argument("--target-ref")
    recover = sub.add_parser("restore")
    recover.add_argument("backup", type=Path)
    recover.add_argument("destination", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    if args.command == "snapshot":
        result = snapshot(args.repo, args.destination, args.target_ref)
        print(f"Verified checkout backup: {len(result['files'])} paths; {args.destination}")
    else:
        restore(args.backup.resolve(), args.destination.resolve())
        print(f"Restored checkout and staging: {args.destination}")


if __name__ == "__main__":
    main()
