# VHS tape to generate style screenshots
# Run: vhs images/screenshot-styles.tape

Output images/styles-all.gif
Set FontSize 22
Set Width 2000
Set Height 1200
Set Theme "Dracula"
Set TypingSpeed 0ms

Type "./plugin/bin/preview.sh --compare-styles --theme=dark --charset=unicode"
Enter
Sleep 5s
