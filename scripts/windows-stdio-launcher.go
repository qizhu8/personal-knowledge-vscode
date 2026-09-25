//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

const createNoWindow = 0x08000000

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "Usage: pkm-stdio-launcher.exe <command> [args...]")
		os.Exit(2)
	}

	command := exec.Command(os.Args[1], os.Args[2:]...)
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNoWindow}

	if err := command.Run(); err != nil {
		if exitError, ok := err.(*exec.ExitError); ok {
			os.Exit(exitError.ExitCode())
		}
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
