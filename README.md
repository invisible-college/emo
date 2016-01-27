# The emo text editor

Hi there! This is a a live code editor.
I'm calling it 'emo' - cuz it's used to support therapy
If you want to create a new live edit page using emo hosted on cheeseburger, just go to
cheeseburgertherapy.com/emo/YOURPAGE

Some key commands:
- ctrl + v moves 10 lines down and can be used for fast scrolling down
- ctrl + V similarly moves 10 lines up
- ctrl + a moves to beginning of line
- ctrl + e moves to end of line

The editor is quite featureless and janky.
Known issues:
- sometimes components won't reload after an error
- only has old school console style scrolling
- no line numbers
- no search / replace
- I broke 'include' statements in demo - need work
- no syntax highlighting
- images need to be hosted somewhere
- the editor pane should be resizeable / positionable
- dragging cursor for text selection is slow
- no undo/redo
- caret doesn't blink
- copy/paste implemented, but 'cut' is not
- fetch / save in the main method is reactive



To run the code:
npm install statebus-server --save
supervisor emo.js

Then visit localhost:3000
Type 'ctrl + m' to see the editor