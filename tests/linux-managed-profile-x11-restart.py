import ctypes
import ctypes.util
import sys
import time

x = ctypes.CDLL(ctypes.util.find_library("X11"))
xt = ctypes.CDLL(ctypes.util.find_library("Xtst"))
x.XOpenDisplay.argtypes = [ctypes.c_char_p]
x.XOpenDisplay.restype = ctypes.c_void_p
x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x.XDefaultRootWindow.restype = ctypes.c_ulong
x.XQueryTree.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong),
                         ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)),
                         ctypes.POINTER(ctypes.c_uint)]
x.XFetchName.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_char_p)]
x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
x.XInternAtom.restype = ctypes.c_ulong
x.XGetWindowProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long, ctypes.c_long,
                                ctypes.c_int, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong),
                                ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong),
                                ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte))]
x.XSetInputFocus.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
x.XStringToKeysym.argtypes = [ctypes.c_char_p]
x.XStringToKeysym.restype = ctypes.c_ulong
x.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
x.XKeysymToKeycode.restype = ctypes.c_ubyte
x.XFlush.argtypes = [ctypes.c_void_p]
x.XFree.argtypes = [ctypes.c_void_p]
x.XCloseDisplay.argtypes = [ctypes.c_void_p]
xt.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]

display = x.XOpenDisplay(None)
if not display:
    raise RuntimeError("Private X display is unavailable")
try:
    root = x.XDefaultRootWindow(display)
    root_return, parent = ctypes.c_ulong(), ctypes.c_ulong()
    children, count = ctypes.POINTER(ctypes.c_ulong)(), ctypes.c_uint()
    if not x.XQueryTree(display, root, ctypes.byref(root_return), ctypes.byref(parent),
                        ctypes.byref(children), ctypes.byref(count)):
        raise RuntimeError("Cannot query private windows")
    matches = []
    for window in children[:count.value]:
        kind, fmt, size, remaining = ctypes.c_ulong(), ctypes.c_int(), ctypes.c_ulong(), ctypes.c_ulong()
        data = ctypes.POINTER(ctypes.c_ubyte)()
        atom = x.XInternAtom(display, b"_NET_WM_NAME", 1)
        if atom and x.XGetWindowProperty(display, window, atom, 0, 2048, 0, 0, ctypes.byref(kind),
                                         ctypes.byref(fmt), ctypes.byref(size), ctypes.byref(remaining),
                                         ctypes.byref(data)) == 0 and data:
            title = ctypes.string_at(data, size.value).decode("utf8", "replace") if fmt.value == 8 else ""
            print("PRIVATE_X11_WINDOW", title, flush=True)
            if sys.argv[1] in title:
                matches.append(window)
            x.XFree(data)
    if children:
        x.XFree(children)
    if len(matches) != 1:
        raise RuntimeError("Cannot uniquely identify private fixture window")
    x.XSetInputFocus(display, matches[0], 1, 0)
    x.XFlush(display)
    time.sleep(0.5)

    def key(name):
        symbol = x.XStringToKeysym(name.encode())
        code = x.XKeysymToKeycode(display, symbol)
        if not code:
            raise RuntimeError("Missing X key " + name)
        xt.XTestFakeKeyEvent(display, code, 1, 0)
        xt.XTestFakeKeyEvent(display, code, 0, 0)
        x.XFlush(display)
        time.sleep(0.04)

    key("F1")
    time.sleep(1)
    for char in "restart extension host":
        key("space" if char == " " else char)
    time.sleep(1)
    key("Return")
finally:
    x.XCloseDisplay(display)
