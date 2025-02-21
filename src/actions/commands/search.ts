import * as _ from 'lodash';
import { escapeRegExp } from 'lodash';
import {} from 'vscode';
import { Position, Range, Selection } from 'vscode';
import { SearchCommandLine } from '../../cmd_line/commandLine';
import { sorted } from '../../common/motion/position';
import { configuration } from '../../configuration/configuration';
import { VimError, ErrorCode } from '../../error';
import { Mode } from '../../mode/mode';
import { Register } from '../../register/register';
import { globalState } from '../../state/globalState';
import { SearchState } from '../../state/searchState';
import { VimState } from '../../state/vimState';
import { StatusBar } from '../../statusBar';
import { TextEditor } from '../../textEditor';
import { TextObject } from '../../textobject/textobject';
import { reportSearch } from '../../util/statusBarTextUtils';
import { SearchDirection } from '../../vimscript/pattern';
import { RegisterAction, BaseCommand } from '../base';
import { failedMovement, IMovement } from '../baseMotion';

/**
 * Search for the word under the cursor; used by [g]* and [g]#
 */
async function searchCurrentWord(
  position: Position,
  vimState: VimState,
  direction: SearchDirection,
  isExact: boolean
): Promise<void> {
  let currentWord = TextEditor.getWord(vimState.document, position);

  if (currentWord) {
    if (/\W/.test(currentWord[0]) || /\W/.test(currentWord[currentWord.length - 1])) {
      // TODO: this kind of sucks. JS regex does not consider the boundary between a special
      // character and whitespace to be a "word boundary", so we can't easily do an exact search.
      isExact = false;
    }

    if (isExact) {
      currentWord = _.escapeRegExp(currentWord);
    }
    // If the search is going left then use `getWordLeft()` on position to start
    // at the beginning of the word. This ensures that any matches happen
    // outside of the currently selected word.
    const searchStartCursorPosition =
      direction === SearchDirection.Backward
        ? vimState.cursorStopPosition.prevWordStart(vimState.document, { inclusive: true })
        : vimState.cursorStopPosition;

    await createSearchStateAndMoveToMatch({
      needle: currentWord,
      vimState,
      direction,
      isExact,
      searchStartCursorPosition,
    });
  } else {
    StatusBar.displayError(vimState, VimError.fromCode(ErrorCode.NoStringUnderCursor));
  }
}

/**
 * Search for the word under the cursor; used by [g]* and [g]# in visual mode when `visualstar` is enabled
 */
async function searchCurrentSelection(vimState: VimState, direction: SearchDirection) {
  const currentSelection = vimState.document.getText(vimState.editor.selection);

  // Go back to Normal mode, otherwise the selection grows to the next match.
  await vimState.setCurrentMode(Mode.Normal);

  const [start, end] = sorted(vimState.cursorStartPosition, vimState.cursorStopPosition);

  // Ensure that any matches happen outside of the currently selected word.
  const searchStartCursorPosition =
    direction === SearchDirection.Backward ? start.getLeft() : end.getRight();

  await createSearchStateAndMoveToMatch({
    needle: currentSelection,
    vimState,
    direction,
    isExact: false,
    searchStartCursorPosition,
  });
}

/**
 * Used by [g]* and [g]#
 */
async function createSearchStateAndMoveToMatch(args: {
  needle: string;
  vimState: VimState;
  direction: SearchDirection;
  isExact: boolean;
  searchStartCursorPosition: Position;
}): Promise<void> {
  const { needle, vimState, isExact } = args;

  if (needle.length === 0) {
    return;
  }

  const searchString = isExact ? `\\<${escapeRegExp(needle)}\\>` : escapeRegExp(needle);

  // Start a search for the given term.
  globalState.searchState = new SearchState(
    args.direction,
    vimState.cursorStopPosition,
    searchString,
    { ignoreSmartcase: true }
  );
  Register.setReadonlyRegister('/', globalState.searchState.searchString);
  SearchCommandLine.addSearchStateToHistory(globalState.searchState);

  // Turn one of the highlighting flags back on (turned off with :nohl)
  globalState.hl = true;

  const nextMatch = globalState.searchState.getNextSearchMatchPosition(
    vimState.editor,
    args.searchStartCursorPosition
  );
  if (nextMatch) {
    vimState.cursorStopPosition = nextMatch.pos;

    reportSearch(
      nextMatch.index,
      globalState.searchState.getMatchRanges(vimState.editor).length,
      vimState
    );
  } else {
    StatusBar.displayError(
      vimState,
      VimError.fromCode(
        args.direction === SearchDirection.Forward
          ? ErrorCode.SearchHitBottom
          : ErrorCode.SearchHitTop,
        globalState.searchState.searchString
      )
    );
  }
}

@RegisterAction
class CommandSearchCurrentWordExactForward extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['*'];
  override isMotion = true;
  override runsOnceForEachCountPrefix = true;
  override isJump = true;

  public override async exec(position: Position, vimState: VimState): Promise<void> {
    await searchCurrentWord(position, vimState, SearchDirection.Forward, true);
  }
}

@RegisterAction
class CommandSearchCurrentWordForward extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine];
  keys = ['g', '*'];
  override isMotion = true;
  override runsOnceForEachCountPrefix = true;
  override isJump = true;

  public override async exec(position: Position, vimState: VimState): Promise<void> {
    await searchCurrentWord(position, vimState, SearchDirection.Forward, false);
  }
}

@RegisterAction
class CommandSearchVisualForward extends BaseCommand {
  modes = [Mode.Visual, Mode.VisualLine];
  keys = ['*'];
  override isMotion = true;
  override runsOnceForEachCountPrefix = true;
  override isJump = true;

  public override async exec(position: Position, vimState: VimState): Promise<void> {
    if (configuration.visualstar) {
      await searchCurrentSelection(vimState, SearchDirection.Forward);
    } else {
      await searchCurrentWord(position, vimState, SearchDirection.Forward, true);
    }
  }
}

@RegisterAction
class CommandSearchCurrentWordExactBackward extends BaseCommand {
  modes = [Mode.Normal];
  keys = ['#'];
  override isMotion = true;
  override runsOnceForEachCountPrefix = true;
  override isJump = true;

  public override async exec(position: Position, vimState: VimState): Promise<void> {
    await searchCurrentWord(position, vimState, SearchDirection.Backward, true);
  }
}

@RegisterAction
class CommandSearchCurrentWordBackward extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine];
  keys = ['g', '#'];
  override isMotion = true;
  override runsOnceForEachCountPrefix = true;
  override isJump = true;

  public override async exec(position: Position, vimState: VimState): Promise<void> {
    await searchCurrentWord(position, vimState, SearchDirection.Backward, false);
  }
}

@RegisterAction
class CommandSearchVisualBackward extends BaseCommand {
  modes = [Mode.Visual, Mode.VisualLine];
  keys = ['#'];
  override isMotion = true;
  override runsOnceForEachCountPrefix = true;
  override isJump = true;

  public override async exec(position: Position, vimState: VimState): Promise<void> {
    if (configuration.visualstar) {
      await searchCurrentSelection(vimState, SearchDirection.Backward);
    } else {
      await searchCurrentWord(position, vimState, SearchDirection.Backward, true);
    }
  }
}

@RegisterAction
class CommandSearchForwards extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine, Mode.VisualBlock];
  keys = ['/'];
  override isMotion = true;
  override isJump = true;
  override runsOnceForEveryCursor() {
    return false;
  }

  public override async exec(position: Position, vimState: VimState): Promise<void> {
    vimState.commandLine = new SearchCommandLine(vimState, '', SearchDirection.Forward);
    await vimState.setCurrentMode(Mode.SearchInProgressMode);

    // Reset search history index
    globalState.searchState = vimState.commandLine.getSearchState();
    vimState.commandLine.historyIndex = SearchCommandLine.previousSearchStates.length;
  }
}

@RegisterAction
class CommandSearchBackwards extends BaseCommand {
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine, Mode.VisualBlock];
  keys = ['?'];
  override isMotion = true;
  override isJump = true;
  override runsOnceForEveryCursor() {
    return false;
  }

  public override async exec(position: Position, vimState: VimState): Promise<void> {
    vimState.commandLine = new SearchCommandLine(vimState, '', SearchDirection.Backward);
    await vimState.setCurrentMode(Mode.SearchInProgressMode);

    // Reset search history index
    globalState.searchState = vimState.commandLine.getSearchState();
    vimState.commandLine.historyIndex = SearchCommandLine.previousSearchStates.length;
  }
}

abstract class SearchObject extends TextObject {
  override modes = [Mode.Normal, Mode.Visual, Mode.VisualBlock];
  protected abstract readonly direction: SearchDirection;

  public async execAction(position: Position, vimState: VimState): Promise<IMovement> {
    const searchState = globalState.searchState;
    if (!searchState || searchState.searchString === '') {
      return failedMovement(vimState);
    }

    const newSearchState = new SearchState(
      this.direction,
      vimState.cursorStopPosition,
      searchState.searchString,
      {}
    );

    let result:
      | {
          range: Range;
          index: number;
        }
      | undefined;

    // At first, try to search for current word, and stop searching if matched.
    // Try to search for the next word if not matched or
    // if the cursor is at the end of a match string in visual-mode.
    result = newSearchState.findContainingMatchRange(vimState.editor, vimState.cursorStopPosition);
    if (
      result &&
      vimState.currentMode === Mode.Visual &&
      vimState.cursorStopPosition.isEqual(result.range.end.getLeftThroughLineBreaks())
    ) {
      result = undefined;
    }

    if (result === undefined) {
      // Try to search for the next word
      result = newSearchState.getNextSearchMatchRange(vimState.editor, vimState.cursorStopPosition);
      if (result === undefined) {
        return failedMovement(vimState);
      }
    }

    reportSearch(result.index, searchState.getMatchRanges(vimState.editor).length, vimState);

    let [start, stop] = [
      vimState.currentMode === Mode.Normal ? result.range.start : vimState.cursorStopPosition,
      result.range.end.getLeftThroughLineBreaks(),
    ];

    if (vimState.recordedState.operator) {
      stop = stop.getLeft();
    }

    // Move the cursor, this is a bit hacky...
    vimState.cursorStartPosition = start;
    vimState.cursorStopPosition = stop;
    vimState.editor.selection = new Selection(start, stop);

    await vimState.setCurrentMode(Mode.Visual);

    return {
      start,
      stop,
    };
  }
}

@RegisterAction
class SearchObjectForward extends SearchObject {
  keys = ['g', 'n'];
  direction = SearchDirection.Forward;
}

@RegisterAction
class SearchObjectBackward extends SearchObject {
  keys = ['g', 'N'];
  direction = SearchDirection.Backward;
}
