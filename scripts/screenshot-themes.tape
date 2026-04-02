# VHS tape to generate theme screenshots
# Run: vhs images/screenshot-themes.tape

Output images/themes-all.gif
Set FontSize 22
Set Width 2000
Set Height 1200
Set Theme "Dracula"
Set TypingSpeed 0ms

Type "./plugin/bin/preview.sh --compare-themes --style=powerline --charset=unicode"
Enter
Sleep 5s
