import * as vscode from 'vscode';

import { RegisterAction, BaseCommand } from '../base';
import { Mode } from '../../mode/mode';
import { VimState } from '../../state/vimState';
import { CommandLine, ExCommandLine } from '../../cmd_line/commandLine';
import { Register, RegisterMode } from '../../register/register';
import { RecordedState } from '../../state/recordedState';
import { TextEditor } from '../../textEditor';
import { StatusBar } from '../../statusBar';
import { getPathDetails, readDirectory } from '../../util/path';
import { Clipboard } from '../../util/clipboard';
import { VimError, ErrorCode } from '../../error';
import { assertDefined } from '../../util/util';
import { builtinExCommands } from '../../vimscript/exCommandParser';

abstract class CommandLineAction extends BaseCommand {
  modes = [Mode.CommandlineInProgress, Mode.SearchInProgressMode];

  override runsOnceForEveryCursor() {
    return false;
  }

  protected abstract run(vimState: VimState, commandLine: CommandLine): Promise<void>;

  public override async exec(position: vscode.Position, vimState: VimState): Promise<void> {
    assertDefined<CommandLine>(vimState.commandLine, 'vimState.commandLine unexpectedly undefined');

    await this.run(vimState, vimState.commandLine);
  }
}

@RegisterAction
class CommandLineTab extends CommandLineAction {
  override modes = [Mode.CommandlineInProgress];
  keys = [['<tab>'], ['<S-tab>']];

  private cycleCompletion(isTabForward: boolean, commandLine: ExCommandLine) {
    const autoCompleteItems = commandLine.autoCompleteItems;
    if (autoCompleteItems.length === 0) {
      return;
    }

    commandLine.autoCompleteIndex = isTabForward
      ? (commandLine.autoCompleteIndex + 1) % autoCompleteItems.length
      : (commandLine.autoCompleteIndex - 1 + autoCompleteItems.length) % autoCompleteItems.length;

    const lastPos = commandLine.preCompleteCharacterPos;
    const lastCmd = commandLine.preCompleteCommand;
    const evalCmd = lastCmd.slice(0, lastPos);
    const restCmd = lastCmd.slice(lastPos);

    commandLine.text = evalCmd + autoCompleteItems[commandLine.autoCompleteIndex] + restCmd;
    commandLine.cursorIndex = commandLine.text.length - restCmd.length;
  }

  protected async run(vimState: VimState, commandLine: CommandLine): Promise<void> {
    if (!(commandLine instanceof ExCommandLine)) {
      throw new Error('Expected ExCommandLine in CommandLineTab::run()');
    }

    const key = this.keysPressed[0];
    const isTabForward = key === '<tab>';

    // If we hit <Tab> twice in a row, definitely cycle
    if (
      commandLine.autoCompleteItems.length !== 0 &&
      vimState.recordedState.actionsRun[vimState.recordedState.actionsRun.length - 2] instanceof
        CommandLineTab
    ) {
      this.cycleCompletion(isTabForward, commandLine);
      return;
    }

    let newCompletionItems: string[] = [];

    // Sub string since vim does completion before the cursor
    let evalCmd = commandLine.text.slice(0, commandLine.cursorIndex);
    const restCmd = commandLine.text.slice(commandLine.cursorIndex);

    // \s* is the match the extra space before any character like ':  edit'
    const cmdRegex = /^\s*\w+$/;
    const fileRegex = /^\s*\w+\s+/g;
    if (cmdRegex.test(evalCmd)) {
      // Command completion
      newCompletionItems = builtinExCommands
        .map((pair) => pair[0][0] + pair[0][1])
        .filter((cmd) => cmd.startsWith(evalCmd))
        // Remove the already typed portion in the array
        .map((cmd) => cmd.slice(cmd.search(evalCmd) + evalCmd.length))
        .sort();
    } else if (fileRegex.exec(evalCmd)) {
      // File completion by searching if there is a space after the first word/command
      // ideally it should be a process of white-listing to selected commands like :e and :vsp
      const filePathInCmd = evalCmd.substring(fileRegex.lastIndex);
      const currentUri = vimState.document.uri;
      const isRemote = !!vscode.env.remoteName;

      const {
        fullDirPath,
        baseName,
        partialPath,
        path: p,
      } = getPathDetails(filePathInCmd, currentUri, isRemote);
      // Update the evalCmd in case of windows, where we change / to \
      evalCmd = evalCmd.slice(0, fileRegex.lastIndex) + partialPath;

      // test if the baseName is . or ..
      const shouldAddDotItems = /^\.\.?$/g.test(baseName);
      const dirItems = await readDirectory(
        fullDirPath,
        p.sep,
        currentUri,
        isRemote,
        shouldAddDotItems
      );
      newCompletionItems = dirItems
        .filter((name) => name.startsWith(baseName))
        .map((name) => name.slice(name.search(baseName) + baseName.length))
        .sort();
    }

    const newIndex = isTabForward ? 0 : newCompletionItems.length - 1;
    commandLine.autoCompleteIndex = newIndex;
    // If here only one items we fill cmd direct, so the next tab will not cycle the one item array
    commandLine.autoCompleteItems = newCompletionItems.length <= 1 ? [] : newCompletionItems;
    commandLine.preCompleteCharacterPos = commandLine.cursorIndex;
    commandLine.preCompleteCommand = evalCmd + restCmd;

    const completion = newCompletionItems.length === 0 ? '' : newCompletionItems[newIndex];
    commandLine.text = evalCmd + completion + restCmd;
    commandLine.cursorIndex = commandLine.text.length - restCmd.length;
  }
}

@RegisterAction
class ExCommandLineEnter extends CommandLineAction {
  override modes = [Mode.CommandlineInProgress];
  keys = [['\n'], ['<C-m>']];

  protected override async run(vimState: VimState, commandLine: CommandLine): Promise<void> {
    await commandLine.run(vimState);
  }
}

@RegisterAction
class SearchCommandLineEnter extends CommandLineAction {
  override modes = [Mode.SearchInProgressMode];
  keys = [['\n'], ['<C-m>']];

  override runsOnceForEveryCursor() {
    return true;
  }
  override isJump = true;

  protected override async run(vimState: VimState, commandLine: CommandLine): Promise<void> {
    await commandLine.run(vimState);
  }
}

@RegisterAction
class CommandLineEscape extends CommandLineAction {
  keys = [['<Esc>'], ['<C-c>'], ['<C-[>']];

  protected override async run(vimState: VimState, commandLine: CommandLine): Promise<void> {
    await commandLine.escape(vimState);
  }
}

@RegisterAction
class CommandLineBackspace extends CommandLineAction {
  keys = [['<BS>'], ['<S-BS>'], ['<C-h>']];

  protected override async run(vimState: VimState, commandLine: CommandLine): Promise<void> {
    await commandLine.backspace(vimState);
  }
}

@RegisterAction
class CommandLineDelete extends CommandLineAction {
  keys = ['<Del>'];

  protected override async run(vimState: VimState, commandLine: CommandLine): Promise<void> {
    await commandLine.delete(vimState);
  }
}

@RegisterAction
class CommandlineHome extends CommandLineAction {
  keys = [['<Home>'], ['<C-b>']];

  protected override async run(vimState: VimState, commandLine: CommandLine): Promise<void> {
    await commandLine.home();
  }
}

@RegisterAction
class CommandLineEnd extends CommandLineAction {
  keys = [['<End>'], ['<C-e>']];

  protected override async run(vimState: VimState, commandLine: CommandLine): Promise<void> {
    await commandLine.end();
  }
}

@RegisterAction
class CommandLineDeleteWord extends CommandLineAction {
  keys = [['<C-w>'], ['<C-BS>']];

  protected override async run(vimState: VimState, commandLine: CommandLine): Promise<void> {
    await commandLine.deleteWord();
  }
}

@RegisterAction
class CommandLineDeleteToBeginning extends CommandLineAction {
  keys = ['<C-u>'];

  protected override async run(vimState: VimState, commandLine: CommandLine): Promise<void> {
    await commandLine.deleteToBeginning();
  }
}

@RegisterAction
class CommandLineWordLeft extends CommandLineAction {
  keys = ['<C-left>'];

  protected async run(vimState: VimState, commandLine: CommandLine): Promise<void> {
    await commandLine.wordLeft();
  }
}

@RegisterAction
class CommandLineWordRight extends CommandLineAction {
  keys = ['<C-right>'];

  protected async run(vimState: VimState, commandLine: CommandLine): Promise<void> {
    await commandLine.wordRight();
  }
}

@RegisterAction
class CommandLineHistoryBack extends CommandLineAction {
  keys = [['<up>'], ['<C-p>']];

  protected async run(vimState: VimState, commandLine: CommandLine): Promise<void> {
    await commandLine.historyBack();
  }
}

@RegisterAction
class CommandLineHistoryForward extends CommandLineAction {
  keys = [['<down>'], ['<C-n>']];

  protected async run(vimState: VimState, commandLine: CommandLine): Promise<void> {
    await commandLine.historyForward();
  }
}

@RegisterAction
class CommandInsertRegisterContentInCommandLine extends CommandLineAction {
  keys = ['<C-r>', '<character>'];
  override isCompleteAction = false;

  protected async run(vimState: VimState, commandLine: CommandLine): Promise<void> {
    if (!Register.isValidRegister(this.keysPressed[1])) {
      return;
    }

    vimState.recordedState.registerName = this.keysPressed[1];
    const register = await Register.get(vimState.recordedState.registerName, this.multicursorIndex);
    if (register === undefined) {
      StatusBar.displayError(
        vimState,
        VimError.fromCode(ErrorCode.NothingInRegister, vimState.recordedState.registerName)
      );
      return;
    }

    let text: string;
    if (register.text instanceof Array) {
      text = register.text.join('\n');
    } else if (register.text instanceof RecordedState) {
      let keyStrokes: string[] = [];

      for (const action of register.text.actionsRun) {
        keyStrokes = keyStrokes.concat(action.keysPressed);
      }

      text = keyStrokes.join('\n');
    } else {
      text = register.text;
    }

    if (register.registerMode === RegisterMode.LineWise) {
      text += '\n';
    }

    commandLine.text += text;
    commandLine.cursorIndex += text.length;
  }
}

@RegisterAction
class CommandInsertWord extends CommandLineAction {
  keys = ['<C-r>', '<C-w>'];

  protected async run(vimState: VimState, commandLine: CommandLine): Promise<void> {
    const word = TextEditor.getWord(vimState.document, vimState.cursorStopPosition.getLeftIfEOL());

    if (word !== undefined) {
      commandLine.text += word;
      commandLine.cursorIndex += word.length;
    }
  }
}

@RegisterAction
class CommandLineLeftRight extends CommandLineAction {
  keys = [['<left>'], ['<right>']];

  private getTrimmedStatusBarText() {
    // first regex removes the : / and | from the string
    // second regex removes a single space from the end of the string
    const trimmedStatusBarText = StatusBar.getText()
      .replace(/^(?:\/|\:)(.*)(?:\|)(.*)/, '$1$2')
      .replace(/(.*) $/, '$1');
    return trimmedStatusBarText;
  }

  protected async run(vimState: VimState, commandLine: CommandLine): Promise<void> {
    const key = this.keysPressed[0];
    const statusBarText = this.getTrimmedStatusBarText();
    if (key === '<right>') {
      commandLine.cursorIndex = Math.min(commandLine.cursorIndex + 1, statusBarText.length);
    } else if (key === '<left>') {
      commandLine.cursorIndex = Math.max(commandLine.cursorIndex - 1, 0);
    }
  }
}

@RegisterAction
class CommandLinePaste extends CommandLineAction {
  keys = [['<C-v>'], ['<D-v>']];

  protected async run(vimState: VimState, commandLine: CommandLine): Promise<void> {
    const textFromClipboard = await Clipboard.Paste();

    commandLine.text = commandLine.text
      .substring(0, commandLine.cursorIndex)
      .concat(textFromClipboard)
      .concat(commandLine.text.slice(commandLine.cursorIndex));
    commandLine.cursorIndex += textFromClipboard.length;
  }
}

@RegisterAction
class CommandCtrlLInSearchMode extends CommandLineAction {
  override modes = [Mode.SearchInProgressMode];
  keys = ['<C-l>'];

  protected async run(vimState: VimState, commandLine: CommandLine): Promise<void> {
    const searchState = commandLine.getSearchState()!;

    const nextMatch = searchState.getNextSearchMatchRange(
      vimState.editor,
      vimState.cursorStopPosition
    );
    if (nextMatch) {
      const line = vimState.document.lineAt(nextMatch.range.end).text;
      if (nextMatch.range.end.character < line.length) {
        searchState.searchString += line[nextMatch.range.end.character];
        commandLine.cursorIndex++;
      }
    }
  }
}

@RegisterAction
class CommandLineType extends CommandLineAction {
  keys = [['<character>']];

  protected async run(vimState: VimState, commandLine: CommandLine): Promise<void> {
    commandLine.typeCharacter(this.keysPressed[0]);
  }
}
