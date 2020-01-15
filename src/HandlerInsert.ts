import {
  ClassDeclaration,
  createSourceFile,
  FunctionDeclaration,
  isClassDeclaration,
  isFunctionDeclaration,
  isVariableStatement,
  VariableStatement,
  ScriptTarget,
  SourceFile,
  Node,
} from 'typescript'
import {
  commands,
  Location,
  Range,
  TextDocument,
  TextEditor,
  TextEditorEdit,
  workspace,
  window,
} from 'vscode'

import {
  buildTsFromDts,
  FunctionParam,
  getComponentElement,
  insertStringToClassComponent,
  insertStringToFunctionalComponent,
  isClassExtendsReactComponent,
} from './ast'
import { matchAntdModule } from './utils'
import { addHandlerPrefix } from './insertion'
import { InsertKind } from './CompletionItem'

export class HandlerInsert {
  private document: TextDocument
  private sFile: SourceFile
  private editor: TextEditor
  private edit: TextEditorEdit
  private triggerCharRange: Range
  private handlerName: string // onChange, onSelect ...
  private fullHandlerName: string // handleOnChange, myOnSelect ...
  private insertKind: InsertKind // handleOnChange, myOnSelect ...
  private handlerBindObject: string

  constructor(
    editor: TextEditor,
    edit: TextEditorEdit,
    sharpSymbolRange: Range,
    document: TextDocument,
    handlerName: string,
    insertKind: InsertKind,
    handlerObject: string
  ) {
    this.editor = editor
    this.document = document
    this.sFile = createSourceFile(document.uri.toString(), document.getText(), ScriptTarget.Latest)
    this.triggerCharRange = sharpSymbolRange
    this.edit = edit
    this.handlerName = handlerName
    this.fullHandlerName = addHandlerPrefix(handlerName)
    this.insertKind = insertKind // handleOnChange, myOnSelect ...
    this.handlerBindObject = handlerObject // `this.`handleOnChange or ``handlerOnChange
  }

  public insertHandler = async () => {
    const { document, triggerCharRange: sharpSymbolRange } = this
    const symbolPosition = sharpSymbolRange.end
    // 1. Get closet outer class component
    // const classComponent = await getClosetClassComponentElement(document, position)
    const classComponent = await getComponentElement<ClassDeclaration>(
      document,
      symbolPosition,
      isClassExtendsReactComponent,
      'outward'
    )

    if (classComponent) {
      // 2-1. insert class component handler
      const functionParams = await this.getHandlerParams()
      const indent = this.countIndentsInNode(classComponent)
      if (functionParams === null) return

      insertStringToClassComponent({
        editor: this.editor,
        document,
        indent,
        classNode: classComponent,
        symbolPosition,
        fullHandlerName: this.fullHandlerName,
        handlerParams: functionParams,
      })
    } else {
      // 2-2. if not found outer class component, it should be functional component
      const functionalComponent = await getComponentElement<
        FunctionDeclaration | VariableStatement
      >(
        document,
        symbolPosition,
        async node => {
          return isFunctionDeclaration(node) || isVariableStatement(node)
        },
        'inward'
      )
      const handlerParams = await this.getHandlerParams()
      if (functionalComponent === null || handlerParams === null) return
      const indent = this.countIndentsInNode(functionalComponent)

      insertStringToFunctionalComponent({
        editor: this.editor,
        document,
        indent,
        functionalNode: functionalComponent,
        symbolPosition,
        fullHandlerName: this.fullHandlerName,
        handlerParams,
      })
    }
  }

  public tryRiseInputBox = async (): Promise<void> => {
    if (this.insertKind === 'direct') return Promise.resolve()

    const fullHandlerNameInput = await window.showInputBox({
      value: '',
      ignoreFocusOut: true,
      placeHolder: 'Input handler name. e.g. `handleOnChange`',
      validateInput: text => {
        return text === '' ? 'Please input handler name' : null
      },
    })

    const fullHandlerName = fullHandlerNameInput || addHandlerPrefix(this.handlerName)
    this.fullHandlerName = fullHandlerName
    return
  }

  private getHandlerParams = async (): Promise<FunctionParam[] | null> => {
    const { document, triggerCharRange: sharpSymbolRange } = this
    const position = sharpSymbolRange.end

    const definitions = await commands.executeCommand<Location[]>(
      'vscode.executeDefinitionProvider',
      document.uri,
      position
    )

    if (!definitions) return null
    const antdDefinition = definitions.find(d => matchAntdModule(d.uri.path))
    if (!antdDefinition) return null
    const dtsDocument = await workspace.openTextDocument(antdDefinition.uri)
    const definitionString = dtsDocument
      .getText()
      .slice(
        dtsDocument.offsetAt(antdDefinition.range.start),
        dtsDocument.offsetAt(antdDefinition.range.end)
      )

    const functionParams = buildTsFromDts(definitionString)
    return functionParams
  }

  public cleanCompletionPrefix = () => {
    const { edit, triggerCharRange } = this
    edit.delete(triggerCharRange)
  }

  public tryFillCompletionBind = () => {
    const { insertKind } = this
    // `direct` mode has been insesrted by `completionItem`
    if (insertKind === 'direct') return

    const cursor = this.editor.selection.active
    const suffix = `={${this.handlerBindObject}${this.fullHandlerName}}`
    this.editor.edit(build => {
      // NOTE: can not use edit.insert, as it only can be called synchronously
      build.insert(cursor, suffix)
    })
  }

  private countIndentsInNode = (node: Node): number => {
    let nodeBodyIndent = 0
    const startLine = this.document.positionAt(node.pos).line + 1
    const endLine = this.document.positionAt(node.end).line

    for (let line = startLine; line <= endLine; line++) {
      const lineText = this.editor.document.lineAt(line).text
      const indentCount = this.countIndentsOfLine(lineText)

      if (nodeBodyIndent === 0 && indentCount > 0) {
        nodeBodyIndent = indentCount
      } else if (indentCount > 0) {
        nodeBodyIndent = Math.min(nodeBodyIndent, indentCount)
      }
    }

    return nodeBodyIndent
  }

  // forked from https://github.com/rubymaniac/vscode-paste-and-indent/blob/master/src/extension.ts#L30-L45
  private countIndentsOfLine = (line: string) => {
    // TODO: indent by space or tab?
    let indentCount = line.search(/\S/) // -1 means the line is blank (full of space characters)
    if (indentCount !== -1) {
      // Normalize the line according to the indentation preferences
      if (this.editor.options.insertSpaces) {
        // When we are in SPACE mode
        const numberOfTabs = line.substring(0, indentCount).split(/\t/).length - 1
        indentCount += numberOfTabs * (Number(this.editor.options.tabSize) - 1)
      } else {
        // When we are in TAB mode
        // Reduce _xmin by how many space characters are in the line
        indentCount -= (line.substring(0, indentCount).match(/[^\t]+/g) || []).length
      }
    }

    return indentCount
  }
}
