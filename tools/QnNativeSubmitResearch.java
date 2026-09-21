// Trace the native Qianniu submit path from known functions and identifying strings.
// @category Qianniu

import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.data.StringDataInstance;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceIterator;

public class QnNativeSubmitResearch extends GhidraScript {
    private static final String[] KNOWN_ADDRESSES = {
        "1804f1760", // CChatContentPresenter::SendMsg
        "1804caba5", // direct SendMsg call in the UI action handler
        "18046c4b0"  // CBottomReceptionPresenter::DoSendMessageAction candidate
    };

    private static final String[] STRING_TERMS = {
        "CChatService::GetPresenter",
        "GetPresenter",
        "DoSendMessageAction",
        "CBottomReceptionPresenter",
        "IChatContentPresenter",
        "IChatContentPresenterForUI",
        "CChatContentPresenter",
        "IAppMessageService",
        "CAppMessageService::SendTextMsg",
        "CMessageBiz::SendTextMsg"
    };

    @Override
    public void run() throws Exception {
        println("PROGRAM " + currentProgram.getName());
        Map<Address, Function> functions = new LinkedHashMap<>();

        for (String rawAddress : KNOWN_ADDRESSES) {
            Address address = toAddr(rawAddress);
            Function function = getFunctionContaining(address);
            println("\nKNOWN " + address + " FUNCTION " + describe(function));
            printInstructions(address, 10, 14);
            if (function != null) {
                functions.put(function.getEntryPoint(), function);
                printReferencesTo(function.getEntryPoint(), functions);
            }
        }

        Set<String> terms = new LinkedHashSet<>(Arrays.asList(STRING_TERMS));
        DataIterator dataIterator = currentProgram.getListing().getDefinedData(true);
        while (dataIterator.hasNext() && !monitor.isCancelled()) {
            Data data = dataIterator.next();
            StringDataInstance stringData = StringDataInstance.getStringDataInstance(data);
            if (stringData == null) {
                continue;
            }
            String value = stringData.getStringValue();
            if (value == null) {
                continue;
            }
            String matched = null;
            for (String term : terms) {
                if (value.contains(term)) {
                    matched = term;
                    break;
                }
            }
            if (matched == null) {
                continue;
            }

            println("\nSTRING_TERM " + matched + " @ " + data.getAddress());
            println("STRING_VALUE " + value);
            ReferenceIterator references = currentProgram.getReferenceManager()
                .getReferencesTo(data.getAddress());
            while (references.hasNext()) {
                Reference reference = references.next();
                Function function = getFunctionContaining(reference.getFromAddress());
                println("  STRING_XREF " + reference.getFromAddress() + " " + describe(function));
                if (function != null) {
                    functions.put(function.getEntryPoint(), function);
                }
            }
        }

        DecompInterface decompiler = new DecompInterface();
        decompiler.toggleCCode(true);
        decompiler.toggleSyntaxTree(true);
        if (!decompiler.openProgram(currentProgram)) {
            printerr("Decompiler could not open program: " + decompiler.getLastMessage());
            return;
        }

        for (Function function : functions.values()) {
            if (monitor.isCancelled()) {
                break;
            }
            println("\nFUNCTION " + describe(function));
            DecompileResults result = decompiler.decompileFunction(function, 180, monitor);
            if (!result.decompileCompleted()) {
                println("DECOMPILE_FAILED " + result.getErrorMessage());
                continue;
            }
            println(result.getDecompiledFunction().getC());
        }
        decompiler.dispose();
    }

    private String describe(Function function) {
        if (function == null) {
            return "<no-function>";
        }
        return function.getName(true) + " @ " + function.getEntryPoint() +
            " BODY " + function.getBody();
    }

    private void printReferencesTo(Address address, Map<Address, Function> functions) {
        ReferenceIterator references = currentProgram.getReferenceManager().getReferencesTo(address);
        while (references.hasNext()) {
            Reference reference = references.next();
            Function caller = getFunctionContaining(reference.getFromAddress());
            println("  TARGET_XREF " + reference.getReferenceType() + " " +
                reference.getFromAddress() + " " + describe(caller));
            if (caller != null) {
                functions.put(caller.getEntryPoint(), caller);
            }
        }
    }

    private void printInstructions(Address center, int before, int after) {
        Instruction current = currentProgram.getListing().getInstructionContaining(center);
        if (current == null) {
            println("  NO_INSTRUCTION " + center);
            return;
        }
        Instruction first = current;
        for (int i = 0; i < before && first.getPrevious() != null; i++) {
            first = first.getPrevious();
        }
        Instruction instruction = first;
        for (int i = 0; instruction != null && i <= before + after; i++) {
            String marker = instruction.equals(current) ? "  >> " : "     ";
            println(marker + instruction.getAddress() + " " + instruction);
            instruction = instruction.getNext();
        }
    }
}
