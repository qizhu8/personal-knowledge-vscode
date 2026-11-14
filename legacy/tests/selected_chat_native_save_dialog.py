import ctypes
import os
import re
import subprocess
import time
from pathlib import Path

from PIL import ImageGrab


def windows():
    return subprocess.check_output(
        ["xwininfo", "-root", "-tree"], env=os.environ, text=True, timeout=5
    )


def dialog(tree, pattern):
    for line in tree.splitlines():
        match = re.search(r'^\s*(0x[0-9a-f]+)\s+"([^"]+)"', line, re.I)
        if match and re.search(pattern, match.group(2), re.I):
            return int(match.group(1), 16)
    return None


def viewable(window):
    detail = subprocess.run(
        ["xwininfo", "-id", hex(window)], env=os.environ, capture_output=True, text=True, timeout=5
    ).stdout
    return "Map State: IsViewable" in detail


def transient_dialog(tree, parent):
    for window in re.findall(r"^\s*(0x[0-9a-f]+)\s", tree, re.I | re.M):
        if int(window, 16) == parent:
            continue
        props = subprocess.run(
            ["xprop", "-id", window, "WM_TRANSIENT_FOR", "_NET_WM_WINDOW_TYPE"],
            env=os.environ, capture_output=True, text=True, timeout=5,
        ).stdout
        match = re.search(r"WM_TRANSIENT_FOR.*window id # (0x[0-9a-f]+)", props, re.I)
        if match and int(match.group(1), 16) == parent and "_NET_WM_WINDOW_TYPE_DIALOG" in props:
            return int(window, 16)
    return None


def wait_dialog(pattern, root, name):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        tree = windows()
        found = dialog(tree, pattern)
        if found is not None and viewable(found):
            time.sleep(0.5)
            with (root / "native-save-dialogs.txt").open("a", encoding="utf-8") as output:
                output.write(f"{name}:\n{tree}\n")
            ImageGrab.grab(xdisplay=os.environ["DISPLAY"]).save(root / f"{name}.png")
            return found
        time.sleep(0.1)
    (root / f"{name}-failure.txt").write_text(windows(), encoding="utf-8")
    ImageGrab.grab(xdisplay=os.environ["DISPLAY"]).save(root / f"{name}-failure.png")
    raise AssertionError(f"Native {name} was not observed")


def complete_native_save(root: Path, page):
    x11 = ctypes.CDLL("libX11.so.6")
    xtest = ctypes.CDLL("libXtst.so.6")
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x11.XKeysymToKeycode.restype = ctypes.c_ubyte
    x11.XSetInputFocus.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    x11.XFlush.argtypes = [ctypes.c_void_p]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    xtest.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    xtest.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
    xtest.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    display = x11.XOpenDisplay(None)
    if not display:
        raise RuntimeError("Unable to open the private X11 display")

    def key(symbol, down):
        code = x11.XKeysymToKeycode(display, symbol)
        if not code or not xtest.XTestFakeKeyEvent(display, code, down, 0):
            raise RuntimeError("X11 input was rejected")
        x11.XFlush(display)
        time.sleep(0.01)

    def press(symbol):
        key(symbol, True)
        key(symbol, False)

    try:
        chooser = wait_dialog(r"^save(?: image| file| as)?$", root, "native-save-dialog")
        x11.XSetInputFocus(display, chooser, 1, 0)
        x11.XFlush(display)
        for character in "export.png":
            if not (character.isascii() and (character.islower() or character.isdigit() or character in "/-._")):
                raise ValueError("Unexpected character in isolated destination")
            press(ord(character))
        key(0xFFE3, True)
        press(ord("a"))
        press(ord("c"))
        key(0xFFE3, False)
        actual = subprocess.check_output(
            ["xclip", "-o", "-selection", "clipboard"], env=os.environ, timeout=5
        ).decode()
        if actual != "export.png":
            raise AssertionError(f"Native save input differed from the isolated destination: {actual!r}")
        press(0xFF57)
        press(0xFF0D)
        deadline = time.monotonic() + 20
        retry_at = time.monotonic() + 2
        clicked = False
        system_confirmed = False
        while time.monotonic() < deadline:
            if (root / "workspace" / "export.png").read_bytes() != b"original isolated destination":
                raise AssertionError("Destination changed before the product overwrite confirmation")
            tree = windows()
            confirmation = dialog(tree, r"confirm save|replace|already exists") or transient_dialog(tree, chooser)
            if confirmation and viewable(confirmation) and not system_confirmed:
                ImageGrab.grab(xdisplay=os.environ["DISPLAY"]).save(root / "native-system-overwrite-dialog.png")
                with (root / "native-save-dialogs.txt").open("a", encoding="utf-8") as output:
                    output.write(f"system overwrite:\n{tree}\n")
                x11.XSetInputFocus(display, confirmation, 1, 0)
                x11.XFlush(display)
                press(0xFF0D)
                system_confirmed = True
            elif not viewable(chooser):
                prompt = page.get_by_text("Replace the selected image file?", exact=True)
                if prompt.is_visible():
                    ImageGrab.grab(xdisplay=os.environ["DISPLAY"]).save(root / "native-overwrite-dialog.png")
                    with (root / "native-save-dialogs.txt").open("a", encoding="utf-8") as output:
                        output.write(f"product overwrite:\n{tree}\n")
                    page.get_by_role("button", name="Replace", exact=True).click()
                    return
                native_prompt = dialog(tree, r"^Visual Studio Code$")
                if native_prompt and viewable(native_prompt):
                    geometry = subprocess.check_output(
                        ["xwininfo", "-id", hex(native_prompt)], env=os.environ, text=True, timeout=5
                    )
                    values = [int(re.search(rf"{label}:\s*(-?\d+)", geometry).group(1)) for label in
                              ("Absolute upper-left X", "Absolute upper-left Y", "Width", "Height")]
                    x, y, width, height = values
                    if not (400 <= width <= 900 and 100 <= height <= 400):
                        raise AssertionError("Unexpected native product dialog geometry")
                    ImageGrab.grab(xdisplay=os.environ["DISPLAY"]).save(root / "native-overwrite-dialog.png")
                    with (root / "native-save-dialogs.txt").open("a", encoding="utf-8") as output:
                        output.write(f"native product overwrite:\n{tree}\n")
                    xtest.XTestFakeMotionEvent(display, -1, x + width * 3 // 4, y + height - 18, 0)
                    x11.XFlush(display)
                    time.sleep(0.2)
                    xtest.XTestFakeButtonEvent(display, 1, True, 0)
                    x11.XFlush(display)
                    time.sleep(0.1)
                    xtest.XTestFakeButtonEvent(display, 1, False, 0)
                    x11.XFlush(display)
                    return
            elif time.monotonic() >= retry_at and not clicked:
                geometry = subprocess.check_output(["xwininfo", "-id", hex(chooser)], env=os.environ, text=True, timeout=5)
                values = [int(re.search(rf"{label}:\s*(-?\d+)", geometry).group(1)) for label in
                          ("Absolute upper-left X", "Absolute upper-left Y", "Width", "Height")]
                x, y, width, height = values
                xtest.XTestFakeMotionEvent(display, -1, x + width - 50, y + height - 23, 0)
                x11.XFlush(display)
                time.sleep(0.2)
                xtest.XTestFakeButtonEvent(display, 1, True, 0)
                x11.XFlush(display)
                time.sleep(0.1)
                xtest.XTestFakeButtonEvent(display, 1, False, 0)
                x11.XFlush(display)
                clicked = True
            time.sleep(0.1)
        (root / "native-overwrite-dialog-failure.txt").write_text(windows(), encoding="utf-8")
        ImageGrab.grab(xdisplay=os.environ["DISPLAY"]).save(root / "native-overwrite-dialog-failure.png")
        raise AssertionError("Real product overwrite confirmation was not observed")
    finally:
        x11.XCloseDisplay(display)
