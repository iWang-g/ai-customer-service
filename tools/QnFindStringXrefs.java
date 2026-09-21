// Find references to selected strings and decompile their containing functions.
// @category Qianniu

import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.Set;

import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.data.StringDataInstance;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.listing.Function;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceIterator;

public class QnFindStringXrefs extends GhidraScript {
    private static final String[] DEFAULT_TARGETS = {
        "SendMsg",
        "sendmsg",
        "OnAliIMSendMsg",
        "FastReSendChatMsg",
        "InsertText2InputBox",
        "insertText2Inputbox",
        "SendTextMsg"
    };

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        Set<String> targets = new LinkedHashSet<>(
            Arrays.asList(args.length == 0 ? DEFAULT_TARGETS : args));
        Set<Function> functions = new LinkedHashSet<>();

        println("PROGRAM " + currentProgram.getName());
        DataIterator dataIterator = currentProgram.getListing().getDefinedData(true);
        while (dataIterator.hasNext() && !monitor.isCancelled()) {
            Data data = dataIterator.next();
            StringDataInstance stringData = StringDataInstance.getStringDataInstance(data);
            if (stringData == null) {
                continue;
            }
            String value = stringData.getStringValue();
            if (value == null || !targets.contains(value)) {
                continue;
            }

            println("\nSTRING " + value + " @ " + data.getAddress());
            ReferenceIterator references = currentProgram.getReferenceManager()
                .getReferencesTo(data.getAddress());
            while (references.hasNext()) {
                Reference reference = references.next();
                Function function = currentProgram.getFunctionManager()
                    .getFunctionContaining(reference.getFromAddress());
                println("  XREF " + reference.getFromAddress() + " " +
                    (function == null ? "<no-function>" : function.getName(true)));
                if (function != null) {
                    functions.add(function);
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

        for (Function function : functions) {
            if (monitor.isCancelled()) {
                break;
            }
            println("\nFUNCTION " + function.getName(true) + " @ " + function.getEntryPoint());
            DecompileResults result = decompiler.decompileFunction(function, 120, monitor);
            if (!result.decompileCompleted()) {
                println("DECOMPILE_FAILED " + result.getErrorMessage());
                continue;
            }
            println(result.getDecompiledFunction().getC());
        }
        decompiler.dispose();
    }
}
