// Print a bounded instruction window around selected addresses.
// @category Qianniu

import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Instruction;

public class QnPrintInstructions extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] arguments = getScriptArgs();
        if (arguments.length == 0) {
            printerr("Pass one or more addresses.");
            return;
        }
        for (String rawAddress : arguments) {
            Address address = toAddr(rawAddress);
            Instruction center = currentProgram.getListing().getInstructionContaining(address);
            Function function = getFunctionContaining(address);
            println("\nADDRESS " + address + " FUNCTION " +
                (function == null ? "<none>" : function.getName() + " @ " + function.getEntryPoint()));
            if (center == null) {
                println("  <no instruction>");
                continue;
            }
            Instruction first = center;
            for (int index = 0; index < 48 && first.getPrevious() != null; index++) {
                first = first.getPrevious();
            }
            Instruction current = first;
            for (int index = 0; current != null && index < 112; index++) {
                println((current.equals(center) ? "  >> " : "     ") +
                    current.getAddress() + " " + current);
                current = current.getNext();
            }
        }
    }
}
