# Terminal demo for the README. Render from the repository root after `npm run build`:
#   vhs docs/demo.tape
# Runs in a throwaway project under /tmp with the built-in policy plus a fresh `agent-fence init`.

Output docs/demo.gif

Set Shell "bash"
Set FontSize 16
Set Width 1400
Set Height 600
Set Padding 16
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set Framerate 12

Hide
Type `export BASH_SILENCE_DEPRECATION_WARNING=1 PS1='$ ' AF="node $PWD/dist/cli.js"` Enter
Type `alias agent-fence="$AF"` Enter
Type `D=/tmp/agent-fence-demo && rm -rf $D && mkdir -p $D/home $D/my-app/app` Enter
Type `export HOME=$D/home && cd $D/my-app && git init -q && echo "API_KEY=not-a-real-key" > .env && clear` Enter
Sleep 1s
Show

Type "agent-fence init"
Sleep 400ms
Enter
Sleep 1.5s
Type `agent-fence check --tool bash --input "cd app && git push --force"`
Sleep 600ms
Enter
Sleep 3s
Type `agent-fence check --tool bash --input "cat .env"`
Sleep 600ms
Enter
Sleep 3s
Type `agent-fence check --tool bash --input "npm test"`
Sleep 600ms
Enter
Sleep 4s
