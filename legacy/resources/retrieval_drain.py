import threading


class DrainAdmission:
    def __init__(self):
        self._condition = threading.Condition()
        self._active = 0
        self._draining = False

    def enter(self):
        with self._condition:
            if self._draining:
                return False
            self._active += 1
            return True

    def retain(self):
        with self._condition:
            self._active += 1

    def leave(self):
        with self._condition:
            self._active -= 1
            if self._active == 0:
                self._condition.notify_all()

    def drain(self):
        with self._condition:
            if self._draining:
                return False
            self._draining = True
            return True

    def accepting(self):
        with self._condition:
            return not self._draining

    def wait(self):
        with self._condition:
            while self._active:
                self._condition.wait()
