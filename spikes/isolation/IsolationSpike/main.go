package main

import (
	"embed"
	"log"
	"os"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	ev := evidenceDir()
	log.Printf("[spike] evidence dir = %s", ev)
	log.Printf("[spike] block mode = %v", spikeBlockMode())

	app := application.New(application.Options{
		Name:        "IsolationSpike",
		Description: "Wails v3 isolation spike: C-01 (middleware) + C-09 (window-id forgery)",
		Services: []application.Service{
			application.NewService(&GreetService{}),
			application.NewService(&SecretService{}),
		},
		Assets: application.AssetOptions{
			Handler:    application.AssetFileServerFS(assets),
			Middleware: ipcMiddleware,
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})

	// A named window matters for C-09: x-wails-window-name is only injected
	// when the window has a name (application.go:398-400).
	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             "main-window",
		Title:            "Wails Isolation Spike",
		Width:            1200,
		Height:           900,
		URL:              "/",
		BackgroundColour: application.NewRGB(18, 18, 26),
	})

	// Arch-B prototype: the reader runs in its OWN window. Its /wails/runtime
	// calls are denied by the middleware using the native window name, while the
	// main window keeps full access.
	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             "reader-window",
		Title:            "Untrusted reader window (Arch-B prototype)",
		Width:            640,
		Height:           420,
		URL:              "/?spike=reader",
		BackgroundColour: application.NewRGB(40, 10, 10),
	})

	if err := app.Run(); err != nil {
		log.Printf("[spike] app.Run error: %v", err)
		os.Exit(1)
	}
}
