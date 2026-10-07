"""Restore synthetic repositories only; never execute the deployment workflow."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("snapshot", Path(__file__).with_name("deploy_snapshot.py"))
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)


class CheckoutRestore(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fpc-synthetic-restore-")
        self.root = Path(self.temp.name)
        self.repo = self.root / "source"
        self.repo.mkdir()
        self.backup = self.root / "backup"
        self.git("init", "-q")
        self.git("config", "user.name", "Synthetic test")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "commit.gpgsign", "false")
        (self.repo / ".gitignore").write_text("runtime/\n")
        (self.repo / "text.txt").write_text("original\n")
        (self.repo / "binary.bin").write_bytes(b"\x00original\xff")
        (self.repo / "delete.txt").write_text("original deleted file")
        self.git("add", ".")
        self.git("commit", "-qm", "base")

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return snapshot.git(self.repo, *args)

    def test_roundtrip_overlapping_index_binary_untracked_and_runtime(self):
        (self.repo / "text.txt").write_text("staged\n")
        (self.repo / "binary.bin").write_bytes(b"\x00staged\xff")
        self.git("add", "text.txt", "binary.bin")
        (self.repo / "text.txt").write_text("latest unstaged\n")
        (self.repo / "binary.bin").write_bytes(b"\x00latest unstaged\xff")
        (self.repo / "delete.txt").unlink()
        (self.repo / "한글 space\nfile.txt").write_text("untracked contents")
        (self.repo / "link").symlink_to("/tmp/nonexistent-fpc-synthetic-target")
        (self.repo / "executable").write_text("#!/bin/sh\nexit 0\n")
        (self.repo / "executable").chmod(0o755)
        (self.repo / "runtime").mkdir()
        (self.repo / "runtime/recording.ts").write_bytes(b"synthetic recording")
        expected_status = snapshot.status(self.repo)
        snapshot.snapshot(self.repo, self.backup)
        self.assertTrue((self.backup / "VERIFIED").exists())
        restored = self.root / "restored"
        snapshot.restore(self.backup, restored)
        self.assertEqual(snapshot.status(restored), expected_status)
        self.assertEqual(snapshot.status(self.repo), expected_status)
        self.assertEqual((self.repo / "runtime/recording.ts").read_bytes(), b"synthetic recording")
        self.assertFalse((restored / "runtime").exists())
        self.assertEqual((restored / "text.txt").read_text(), "latest unstaged\n")
        self.assertEqual(snapshot.git(restored, "show", ":text.txt"), b"staged\n")
        self.assertEqual((restored / "binary.bin").read_bytes(), b"\x00latest unstaged\xff")
        self.assertEqual((restored / "한글 space\nfile.txt").read_text(), "untracked contents")

    def test_staged_deletion_addition_and_rename(self):
        self.git("rm", "delete.txt")
        self.git("mv", "text.txt", "renamed.txt")
        (self.repo / "new.txt").write_text("staged new")
        self.git("add", "new.txt")
        (self.repo / "new.txt").write_text("unstaged new")
        snapshot.snapshot(self.repo, self.backup)

    def test_verification_failure_never_marks_verified_or_changes_source(self):
        (self.repo / "text.txt").write_text("must survive")
        with patch.object(snapshot, "restore", side_effect=RuntimeError("synthetic restore failure")):
            with self.assertRaises(RuntimeError):
                snapshot.snapshot(self.repo, self.backup)
        self.assertFalse((self.backup / "VERIFIED").exists())
        self.assertEqual((self.repo / "text.txt").read_text(), "must survive")

    def test_corruption_is_rejected_before_restore(self):
        snapshot.snapshot(self.repo, self.backup)
        with (self.backup / "worktree.tar").open("ab") as stream:
            stream.write(b"corruption")
        with self.assertRaisesRegex(RuntimeError, "checksum"):
            snapshot.restore(self.backup, self.root / "restored")
        self.assertFalse((self.root / "restored").exists())

    def test_edit_during_restore_verification_does_not_authorize_cleanup(self):
        original_restore = snapshot.restore
        def edit_after_restore(*args):
            result = original_restore(*args)
            (self.repo / "text.txt").write_text("edit arriving during the drill")
            return result
        with patch.object(snapshot, 'restore', side_effect=edit_after_restore):
            with self.assertRaisesRegex(RuntimeError, 'changed during'):
                snapshot.snapshot(self.repo, self.backup)
        self.assertFalse((self.backup / "VERIFIED").exists())
        self.assertEqual((self.repo / "text.txt").read_text(), 'edit arriving during the drill')

    def test_ignored_runtime_collision_blocks_new_revision(self):
        (self.repo / "runtime").mkdir()
        (self.repo / "runtime/recording.ts").write_bytes(b"must survive")
        # A target tree containing the ignored runtime path, with no checkout.
        blob = self.git("hash-object", "-w", "runtime/recording.ts").decode().strip()
        import subprocess
        tree = subprocess.check_output(["git", "-C", str(self.repo), "mktree"],
            input=f"100644 blob {blob}\trecording.ts\n".encode()).decode().strip()
        target = subprocess.check_output(["git", "-C", str(self.repo), "mktree"],
            input=f"040000 tree {tree}\truntime\n".encode()).decode().strip()
        with self.assertRaisesRegex(RuntimeError, "ignored runtime"):
            snapshot.snapshot(self.repo, self.backup, target)
        self.assertFalse(self.backup.exists())
        self.assertEqual((self.repo / "runtime/recording.ts").read_bytes(), b"must survive")

    def test_snapshot_inside_source_and_nonempty_restore_rejected(self):
        with self.assertRaises(RuntimeError):
            snapshot.snapshot(self.repo, self.repo / "backup")
        snapshot.snapshot(self.repo, self.backup)
        with self.assertRaises(RuntimeError):
            snapshot.restore(self.backup, self.repo)


if __name__ == "__main__":
    unittest.main()
