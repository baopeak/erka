# ConPTY (sideloaded)

`conpty.dll` + `OpenConsole.exe` from Microsoft's official NuGet package
`Microsoft.Windows.Console.ConPTY` 1.25.260930003 (Windows Terminal project, MIT license,
Authenticode-signed by Microsoft Corporation).

Why: the ConPTY built into Windows 10 flushes roughly one line per read (measured ~0.37 MiB/s,
60k reads of ~69 B for `cmd /c type` of a 4 MiB file). portable-pty prefers a `conpty.dll`
found next to the executable, so `crates/erkad/build.rs` copies the files in `third_party/conpty/<arch>/` these files beside
`erkad.exe`, and the app bundle ships them next to the daemon.

Update: download the `.nupkg` from nuget.org, verify signatures
(`Get-AuthenticodeSignature`), replace the files, bump the version above.
